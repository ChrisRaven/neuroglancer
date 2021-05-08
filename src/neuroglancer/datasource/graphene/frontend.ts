/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {AnnotationPropertySpec, AnnotationType, ensureUniqueAnnotationPropertyIds, makeDataBoundsBoundingBoxAnnotationSet, parseAnnotationPropertyId, parseAnnotationPropertyType} from 'neuroglancer/annotation';
import {AnnotationGeometryChunkSpecification} from 'neuroglancer/annotation/base';
import {MultiscaleAnnotationSource} from 'neuroglancer/annotation/frontend_source';
import {AnnotationGeometryChunkSource} from 'neuroglancer/annotation/frontend_source';
import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {BoundingBox, CoordinateSpace, coordinateSpaceFromJson, emptyValidCoordinateSpace, makeCoordinateSpace, makeIdentityTransform, makeIdentityTransformedBoundingBox} from 'neuroglancer/coordinate_transform';
import {WithCredentialsProvider} from 'neuroglancer/credentials_provider/chunk_source_frontend';
import {CompleteUrlOptions, ConvertLegacyUrlOptions, DataSource, DataSourceProvider, DataSubsourceEntry, GetDataSourceOptions, NormalizeUrlOptions, RedirectError} from 'neuroglancer/datasource';
// import {AnnotationSourceParameters, AnnotationSpatialIndexSourceParameters, DataEncoding, IndexedSegmentPropertySourceParameters, MeshSourceParameters, MultiscaleMeshMetadata, MultiscaleMeshSourceParameters, ShardingHashFunction, ShardingParameters, SkeletonMetadata, SkeletonSourceParameters, VolumeChunkEncoding, VolumeChunkSourceParameters} from 'neuroglancer/datasource/precomputed/base';
import {VertexPositionFormat} from 'neuroglancer/mesh/base';
import {MeshSource, MultiscaleMeshSource} from 'neuroglancer/mesh/frontend';
import {IndexedSegmentProperty} from 'neuroglancer/segmentation_display_state/base';
import {IndexedSegmentPropertySource, InlineSegmentProperty, InlineSegmentPropertyMap, SegmentPropertyMap} from 'neuroglancer/segmentation_display_state/property_map';
import {VertexAttributeInfo} from 'neuroglancer/skeleton/base';
import {SkeletonSource} from 'neuroglancer/skeleton/frontend';
import {makeSliceViewChunkSpecification} from 'neuroglancer/sliceview/base';
import {SliceViewSingleResolutionSource} from 'neuroglancer/sliceview/frontend';
import {DataType, makeDefaultVolumeChunkSpecifications, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {transposeNestedArrays} from 'neuroglancer/util/array';
import {Borrowed} from 'neuroglancer/util/disposable';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {completeHttpPath} from 'neuroglancer/util/http_path_completion';
import {isNotFoundError, responseJson} from 'neuroglancer/util/http_request';
import {parseArray, parseFixedLengthArray, parseQueryStringParameters, unparseQueryStringParameters, verifyEnumString, verifyFiniteFloat, verifyFinitePositiveFloat, verifyInt, verifyObject, verifyObjectProperty, verifyOptionalObjectProperty, verifyOptionalString, verifyPositiveInt, verifyString, verifyStringArray, verifyNonnegativeInt} from 'neuroglancer/util/json';
import * as matrix from 'neuroglancer/util/matrix';
import {getObjectId} from 'neuroglancer/util/object_id';
import {cancellableFetchSpecialOk, parseSpecialUrl, SpecialProtocolCredentials, SpecialProtocolCredentialsProvider} from 'neuroglancer/util/special_protocol_request';

import {ChunkedGraphSourceParameters, DataEncoding, MeshSourceParameters, MultiscaleMeshMetadata, PYCG_APP_VERSION, ShardingHashFunction, ShardingParameters, SkeletonMetadata, SkeletonSourceParameters, VolumeChunkEncoding, VolumeChunkSourceParameters} from 'neuroglancer/datasource/graphene/base';
import {IndexedSegmentPropertySourceParameters} from 'neuroglancer/datasource/graphene/base';
import {ChunkedGraphChunkSource, WithRootSegments} from 'neuroglancer/sliceview/chunked_graph/frontend';
import {StatusMessage} from 'neuroglancer/status';

import {AnnotationSpatialIndexSourceParameters, AnnotationSourceParameters} from 'neuroglancer/datasource/graphene/base';
import { makeChunkedGraphChunkSpecification, ChunkedGraphSourceOptions } from 'src/neuroglancer/sliceview/chunked_graph/base';
import { Uint64Set } from 'src/neuroglancer/uint64_set';

class GrapheneVolumeChunkSource extends
(WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(VolumeChunkSource), VolumeChunkSourceParameters)) {}


// class GrapheneVolumeChunkSource extends
// (WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(VolumeChunkSource), VolumeChunkSourceParameters)) {}

class GrapheneChunkedGraphChunkSource extends
(WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(ChunkedGraphChunkSource), ChunkedGraphSourceParameters)) {}

class GrapheneMeshSource extends
(WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(MeshSource), MeshSourceParameters)) {}

// class GrapheneMultiscaleMeshSource extends
// (WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(MultiscaleMeshSource), MultiscaleMeshSourceParameters)) {}

class GrapheneSkeletonSource extends
(WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(SkeletonSource), SkeletonSourceParameters)) {
  get skeletonVertexCoordinatesInVoxels() {
    return false;
  }
  get vertexAttributes() {
    return this.parameters.metadata.vertexAttributes;
  }
}

function resolvePath(a: string, b: string) {
  const outputParts = a.split('/');
  for (const part of b.split('/')) {
    if (part === '..') {
      if (outputParts.length !== 0) {
        outputParts.length = outputParts.length - 1;
        continue;
      }
    }
    outputParts.push(part);
  }
  return outputParts.join('/');
}

class ScaleInfo {
  key: string;
  encoding: VolumeChunkEncoding;
  resolution: Float64Array;
  voxelOffset: Float32Array;
  size: Float32Array;
  chunkSizes: Uint32Array[];
  compressedSegmentationBlockSize: vec3|undefined;
  sharding: ShardingParameters|undefined;
  constructor(obj: any, numChannels: number) {
    verifyObject(obj);
    const rank = (numChannels === 1) ? 3 : 4;
    const resolution = this.resolution = new Float64Array(rank);
    const voxelOffset = this.voxelOffset = new Float32Array(rank);
    const size = this.size = new Float32Array(rank);
    if (rank === 4) {
      resolution[3] = 1;
      size[3] = numChannels;
    }
    verifyObjectProperty(
        obj, 'resolution',
        x => parseFixedLengthArray(resolution.subarray(0, 3), x, verifyFinitePositiveFloat));
    verifyOptionalObjectProperty(
        obj, 'voxel_offset', x => parseFixedLengthArray(voxelOffset.subarray(0, 3), x, verifyInt));
    verifyObjectProperty(
        obj, 'size', x => parseFixedLengthArray(size.subarray(0, 3), x, verifyPositiveInt));
    this.chunkSizes = verifyObjectProperty(
        obj, 'chunk_sizes', x => parseArray(x, y => {
                              const chunkSize = new Uint32Array(rank);
                              if (rank === 4) chunkSize[3] = numChannels;
                              parseFixedLengthArray(chunkSize.subarray(0, 3), y, verifyPositiveInt);
                              return chunkSize;
                            }));
    if (this.chunkSizes.length === 0) {
      throw new Error('No chunk sizes specified.');
    }
    this.sharding = verifyObjectProperty(obj, 'sharding', parseShardingParameters);
    if (this.sharding !== undefined && this.chunkSizes.length !== 1) {
      throw new Error('Sharding requires a single chunk size per scale');
    }
    let encoding = this.encoding =
        verifyObjectProperty(obj, 'encoding', x => verifyEnumString(x, VolumeChunkEncoding));
    if (encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATION) {
      this.compressedSegmentationBlockSize = verifyObjectProperty(
          obj, 'compressed_segmentation_block_size',
          x => parseFixedLengthArray(vec3.create(), x, verifyPositiveInt));
    }
    this.key = verifyObjectProperty(obj, 'key', verifyString);
  }
}

class AppInfo {
  segmentationUrl: string;
  meshingUrl: string;
  supported_api_versions: number[];
  constructor(infoUrl: string, obj: any) {
    // .../1.0/... is the legacy link style
    // .../table/... is the current, version agnostic link style (for retrieving the info file)
    const linkStyle = /^(https?:\/\/[.\w:\-\/]+)\/segmentation\/(?:1\.0|table)\/([^\/]+)\/?$/;
    let match = infoUrl.match(linkStyle);
    if (match === null) {
      throw Error(`Graph URL invalid: ${infoUrl}`);
    }
    this.segmentationUrl = `${match[1]}/segmentation/api/v${PYCG_APP_VERSION}/table/${match[2]}`;
    this.meshingUrl = `${match[1]}/meshing/api/v${PYCG_APP_VERSION}/table/${match[2]}`;

    try {
      verifyObject(obj);
      this.supported_api_versions = verifyObjectProperty(
          obj, 'supported_api_versions', x => parseArray(x, verifyNonnegativeInt));
    } catch (error) {
      // Dealing with a prehistoric graph server with no version information
      this.supported_api_versions = [0];
    }
    if (PYCG_APP_VERSION in this.supported_api_versions === false) {
      const redirectMsgBox = new StatusMessage();
      const redirectMsg = `This Neuroglancer branch requires Graph Server version ${
          PYCG_APP_VERSION}, but the server only supports version(s) ${
          this.supported_api_versions}.`;

      if (location.hostname.includes('neuromancer-seung-import.appspot.com')) {
        const redirectLoc = new URL(location.href);
        redirectLoc.hostname = `graphene-v${
            this.supported_api_versions.slice(-1)[0]}-dot-neuromancer-seung-import.appspot.com`;
        redirectMsgBox.setHTML(`Try <a href="${redirectLoc.href}">${redirectLoc.hostname}</a>?`);
      }
      throw new Error(redirectMsg);
    }
  }
}

class GraphInfo {
  chunkSize: vec3;
  constructor(obj: any) {
    verifyObject(obj);
    this.chunkSize = verifyObjectProperty(
        obj, 'chunk_size', x => parseFixedLengthArray(vec3.create(), x, verifyPositiveInt));
  }
}

interface MultiscaleVolumeInfo {
  dataType: DataType;
  volumeType: VolumeType;
  mesh: string|undefined;
  skeletons: string|undefined;
  segmentPropertyMap: string|undefined;
  scales: ScaleInfo[];
  modelSpace: CoordinateSpace;
  dataUrl: string;
  app?: AppInfo;
  graph?: GraphInfo;
}

export function parseSpecialUrl2(url: string): string { // TODO, this is a hack
  const urlProtocolPattern = /^([^:\/]+):\/\/([^\/]+)(\/.*)?$/;
  let match = url.match(urlProtocolPattern);
  if (match === null) {
    throw new Error(`Invalid URL: ${JSON.stringify(url)}`);
  }
  const protocol = match[1];
  if (protocol === 'gs') {
    const bucket = match[2];
    let path = match[3];
    if (path === undefined) path = '';
    return `https://storage.googleapis.com/${bucket}${path}`;
  } else if (protocol === 's3') {
    const bucket = match[2];
    let path = match[3];
    if (path === undefined) path = '';
    return `https://s3.amazonaws.com/${bucket}${path}`;
  }
  return url;
}

function parseMultiscaleVolumeInfo(obj: unknown, url: string): MultiscaleVolumeInfo {
  verifyObject(obj);
  const dataType = verifyObjectProperty(obj, 'data_type', x => verifyEnumString(x, DataType));
  const numChannels = verifyObjectProperty(obj, 'num_channels', verifyPositiveInt);
  let volumeType = verifyObjectProperty(obj, 'type', x => verifyEnumString(x, VolumeType));
  const mesh = verifyObjectProperty(obj, 'mesh', verifyOptionalString);
  const skeletons = verifyObjectProperty(obj, 'skeletons', verifyOptionalString);
  const segmentPropertyMap = verifyObjectProperty(obj, 'segment_properties', verifyOptionalString);
  const scaleInfos =
      verifyObjectProperty(obj, 'scales', x => parseArray(x, y => new ScaleInfo(y, numChannels)));
  if (scaleInfos.length === 0) throw new Error('Expected at least one scale');
  const baseScale = scaleInfos[0];
  const rank = (numChannels === 1) ? 3 : 4;
  const scales = new Float64Array(rank);
  const lowerBounds = new Float64Array(rank);
  const upperBounds = new Float64Array(rank);
  const names = ['x', 'y', 'z'];
  const units = ['m', 'm', 'm'];

  for (let i = 0; i < 3; ++i) {
    scales[i] = baseScale.resolution[i] / 1e9;
    lowerBounds[i] = baseScale.voxelOffset[i];
    upperBounds[i] = lowerBounds[i] + baseScale.size[i];
  }
  if (rank === 4) {
    scales[3] = 1;
    upperBounds[3] = numChannels;
    names[3] = 'c^';
    units[3] = '';
  }
  const box: BoundingBox = {lowerBounds, upperBounds};
  const modelSpace = makeCoordinateSpace({
    rank,
    names,
    units,
    scales,
    boundingBoxes: [makeIdentityTransformedBoundingBox(box)],
  });

  let dataUrl = url;
  let app = undefined;
  let graph = undefined;

  if (volumeType !== VolumeType.IMAGE) {
    volumeType = VolumeType.SEGMENTATION_WITH_GRAPH;
    dataUrl = verifyObjectProperty(obj, 'data_dir', x => parseSpecialUrl2(x));
    app = verifyObjectProperty(obj, 'app', x => new AppInfo(url, x));
    graph = verifyObjectProperty(obj, 'graph', x => new GraphInfo(x));
  }

  

  

  return {
    dataType,
    volumeType,
    mesh,
    skeletons,
    segmentPropertyMap,
    scales: scaleInfos,
    modelSpace,
    app,
    graph,
    dataUrl,
  };
}

class GrapheneMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
  // app: AppInfo;
  // graph: GraphInfo;

  // dataUrl: string;
  // dataType: DataType;
  // numChannels: number;
  // volumeType: VolumeType;
  // mesh: string|undefined;
  // verifyMesh: boolean|undefined;
  // skeletons: string|undefined;
  // app: AppInfo;
  // graph: GraphInfo;
  // scales: ScaleInfo[];

  getChunkedGraphUrl() {
    return this.info.app?.segmentationUrl;
  }

  public async getTimestampLimit() {
    const response =  await cancellableFetchSpecialOk(
      this.credentialsProvider, `${this.getChunkedGraphUrl()}/oldest_timestamp`, {}, responseJson);
    return verifyObjectProperty(await response.json(), 'iso', verifyString);
  }

  get dataType() {
    return this.info.dataType;
  }

  get volumeType() {
    return this.info.volumeType;
  }

  get rank() {
    return this.info.modelSpace.rank;
  }

  constructor(
      chunkManager: ChunkManager, public credentialsProvider: SpecialProtocolCredentialsProvider,
      public url: string, public info: MultiscaleVolumeInfo) {
    super(chunkManager);
  }

  

  getChunkedGraphSources(options: ChunkedGraphSourceOptions, rootSegments: Uint64Set) {

    const {rank} = this;

    const scaleInfo = this.info.scales[0];

    const spec = makeChunkedGraphChunkSpecification({
      rank,
      dataType: this.info.dataType,
      upperVoxelBound: scaleInfo.size,
      chunkDataSize: Uint32Array.from(this.info.graph!.chunkSize),
      baseVoxelOffset: scaleInfo.voxelOffset,
      // chunkedGraphSourceOptions: options,
    });

    // const spec = makeChunkedGraphChunkSpecification.getDefaults({
    //   numChannels: 1,
    //   voxelSize: this.scales[0].resolution,
    //   transform: mat4.fromTranslation(
    //       mat4.create(),
    //       vec3.multiply(vec3.create(), this.scales[0].resolution, this.scales[0].voxelOffset)),
    //   upperVoxelBound: this.scales[0].size,
    //   chunkDataSizes: [this.graph.chunkSize],
    //   baseVoxelOffset: this.scales[0].voxelOffset,
    //   chunkedGraphSourceOptions: options,
    // });

    // let sources: SliceViewSingleResolutionSource<VolumeChunkSource>[][] = [];

    const stride = rank + 1;
    const chunkToMultiscaleTransform = new Float32Array(stride * stride);

    return [[
      {
        chunkSource: this.chunkManager.getChunkSource(GrapheneChunkedGraphChunkSource, {
          spec,
          credentialsProvider: this.credentialsProvider,
          /*rootSegments,*/
          parameters: {url: `${this.info.app!.segmentationUrl}/node`}}),
        chunkToMultiscaleTransform
      }
    ]];
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    const modelResolution = this.info.scales[0].resolution;
    const {rank} = this;
    return transposeNestedArrays(this.info.scales.map(scaleInfo => {
      const {resolution} = scaleInfo;
      const stride = rank + 1;
      const chunkToMultiscaleTransform = new Float32Array(stride * stride);
      chunkToMultiscaleTransform[chunkToMultiscaleTransform.length - 1] = 1;
      for (let i = 0; i < 3; ++i) {
        const relativeScale = resolution[i] / modelResolution[i];
        chunkToMultiscaleTransform[stride * i + i] = relativeScale;
        chunkToMultiscaleTransform[stride * rank + i] = scaleInfo.voxelOffset[i] * relativeScale;
      }
      if (rank === 4) {
        chunkToMultiscaleTransform[stride * 3 + 3] = 1;
      }
      const x = makeDefaultVolumeChunkSpecifications({
               rank,
               dataType: this.dataType,
               chunkToMultiscaleTransform,
               upperVoxelBound: scaleInfo.size,
               volumeType: this.volumeType,
               chunkDataSizes: scaleInfo.chunkSizes,
               baseVoxelOffset: scaleInfo.voxelOffset,
               compressedSegmentationBlockSize: scaleInfo.compressedSegmentationBlockSize,
               volumeSourceOptions,
             })
          .map((spec): SliceViewSingleResolutionSource<VolumeChunkSource> => ({
                 chunkSource: this.chunkManager.getChunkSource(GrapheneVolumeChunkSource, {
                   credentialsProvider: this.credentialsProvider,
                   spec,
                   parameters: {
                     url: resolvePath(this.url, scaleInfo.key),
                     encoding: scaleInfo.encoding,
                     sharding: scaleInfo.sharding,
                   }
                 }),
                 chunkToMultiscaleTransform,
               }));

      return x;
    }));
  }
}

const MultiscaleAnnotationSourceBase = (WithParameters(
    WithCredentialsProvider<SpecialProtocolCredentials>()(MultiscaleAnnotationSource),
    AnnotationSourceParameters));

class GrapheneAnnotationSpatialIndexSource extends
(WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(AnnotationGeometryChunkSource), AnnotationSpatialIndexSourceParameters)) {}

interface GrapheneAnnotationSourceOptions {
  metadata: AnnotationMetadata;
  parameters: AnnotationSourceParameters;
  credentialsProvider: SpecialProtocolCredentialsProvider;
}

export class GrapheneAnnotationSource extends MultiscaleAnnotationSourceBase {
  key: any;
  metadata: AnnotationMetadata;
  credentialsProvider: SpecialProtocolCredentialsProvider;
  OPTIONS: GrapheneAnnotationSourceOptions;
  constructor(chunkManager: ChunkManager, options: GrapheneAnnotationSourceOptions) {
    const {parameters} = options;
    super(chunkManager, {
      rank: parameters.rank,
      relationships: parameters.relationships.map(x => x.name),
      properties: parameters.properties,
      parameters,
    } as any);
    this.readonly = true;
    this.metadata = options.metadata;
    this.credentialsProvider = options.credentialsProvider;
  }

  getSources(): SliceViewSingleResolutionSource<AnnotationGeometryChunkSource>[][] {
    return [this.metadata.spatialIndices.map(spatialIndexLevel => {
      const {spec} = spatialIndexLevel;
      return {
        chunkSource: this.chunkManager.getChunkSource(GrapheneAnnotationSpatialIndexSource, {
          credentialsProvider: this.credentialsProvider,
          parent: this,
          spec,
          parameters: spatialIndexLevel.parameters,
        }),
        chunkToMultiscaleTransform: spec.chunkToMultiscaleTransform,
      };
    })];
  }
}

function getLegacyMeshSource(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    parameters: MeshSourceParameters) {
  return chunkManager.getChunkSource(GrapheneMeshSource, {parameters, credentialsProvider});
}

function parseTransform(data: any): mat4 {
  return verifyObjectProperty(data, 'transform', value => {
    const transform = mat4.create();
    if (value !== undefined) {
      parseFixedLengthArray(transform.subarray(0, 12), value, verifyFiniteFloat);
    }
    mat4.transpose(transform, transform);
    return transform;
  });
}

interface ParsedMeshMetadata {
  metadata: MultiscaleMeshMetadata|undefined;
  segmentPropertyMap?: string|undefined;
}

function parseMeshMetadata(data: any): ParsedMeshMetadata {
  verifyObject(data);
  const t = verifyObjectProperty(data, '@type', verifyString);
  let metadata: MultiscaleMeshMetadata|undefined;
  if (t === 'neuroglancer_legacy_mesh') {
    metadata = undefined;
  } else if (t !== 'neuroglancer_multilod_draco') {
    throw new Error(`Unsupported mesh type: ${JSON.stringify(t)}`);
  } else {
    const lodScaleMultiplier =
        verifyObjectProperty(data, 'lod_scale_multiplier', verifyFinitePositiveFloat);
    const vertexQuantizationBits =
        verifyObjectProperty(data, 'vertex_quantization_bits', verifyPositiveInt);
    const transform = parseTransform(data);
    const sharding = verifyObjectProperty(data, 'sharding', parseGrapheneShardingParameters);
    metadata = {lodScaleMultiplier, transform, sharding, vertexQuantizationBits};
  }
  const segmentPropertyMap = verifyObjectProperty(data, 'segment_properties', verifyOptionalString);
  return {metadata, segmentPropertyMap};
}

async function getMeshMetadata(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string): Promise<ParsedMeshMetadata> {
  let metadata: any;
  try {
    metadata = await getJsonMetadata(chunkManager, credentialsProvider, url);
  } catch (e) {
    if (isNotFoundError(e)) {
      // If we fail to fetch the info file, assume it is the legacy
      // single-resolution mesh format.
      return {metadata: undefined};
    }
    throw e;
  }
  return parseMeshMetadata(metadata);
}

function parseShardingEncoding(y: any): DataEncoding {
  if (y === undefined) return DataEncoding.RAW;
  return verifyEnumString(y, DataEncoding);
}

function parseShardingParameters(shardingData: any): ShardingParameters|undefined {
  if (shardingData === undefined) return undefined;
  verifyObject(shardingData);
  const t = verifyObjectProperty(shardingData, '@type', verifyString);
  if (t !== 'neuroglancer_uint64_sharded_v1') {
    throw new Error(`Unsupported sharding format: ${JSON.stringify(t)}`);
  }
  const hash =
      verifyObjectProperty(shardingData, 'hash', y => verifyEnumString(y, ShardingHashFunction));
  const preshiftBits = verifyObjectProperty(shardingData, 'preshift_bits', verifyInt);
  const shardBits = verifyObjectProperty(shardingData, 'shard_bits', verifyInt);
  const minishardBits = verifyObjectProperty(shardingData, 'minishard_bits', verifyInt);
  const minishardIndexEncoding =
      verifyObjectProperty(shardingData, 'minishard_index_encoding', parseShardingEncoding);
  const dataEncoding = verifyObjectProperty(shardingData, 'data_encoding', parseShardingEncoding);
  return {hash, preshiftBits, shardBits, minishardBits, minishardIndexEncoding, dataEncoding};
}

function parseGrapheneShardingParameters(shardingData: any): Array<ShardingParameters>|undefined {
  if (shardingData === undefined) return undefined;
  verifyObject(shardingData);
  let grapheneShardingParameters = new Array<ShardingParameters>();
  for (const layer in shardingData) {
     let index = Number(layer);
     grapheneShardingParameters[index] = parseShardingParameters(shardingData[index])!;
  }
  return grapheneShardingParameters;
}

interface ParsedSkeletonMetadata {
  metadata: SkeletonMetadata;
  segmentPropertyMap: string|undefined;
}

function parseSkeletonMetadata(data: any): ParsedSkeletonMetadata {
  verifyObject(data);
  const t = verifyObjectProperty(data, '@type', verifyString);
  if (t !== 'neuroglancer_skeletons') {
    throw new Error(`Unsupported skeleton type: ${JSON.stringify(t)}`);
  }
  const transform = parseTransform(data);
  const vertexAttributes = new Map<string, VertexAttributeInfo>();
  verifyObjectProperty(data, 'vertex_attributes', attributes => {
    if (attributes === undefined) return;
    parseArray(attributes, attributeData => {
      verifyObject(attributeData);
      const id = verifyObjectProperty(attributeData, 'id', verifyString);
      if (id === '') throw new Error('vertex attribute id must not be empty');
      if (vertexAttributes.has(id)) {
        throw new Error(`duplicate vertex attribute id ${JSON.stringify(id)}`);
      }
      const dataType =
          verifyObjectProperty(attributeData, 'data_type', y => verifyEnumString(y, DataType));
      const numComponents =
          verifyObjectProperty(attributeData, 'num_components', verifyPositiveInt);
      vertexAttributes.set(id, {dataType, numComponents});
    });
  });
  const sharding = verifyObjectProperty(data, 'sharding', parseShardingParameters);
  const segmentPropertyMap = verifyObjectProperty(data, 'segment_properties', verifyOptionalString);
  return {
    metadata: {transform, vertexAttributes, sharding} as SkeletonMetadata,
    segmentPropertyMap
  };
}

async function getSkeletonMetadata(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string): Promise<ParsedSkeletonMetadata> {
  const metadata = await getJsonMetadata(chunkManager, credentialsProvider, url);
  return parseSkeletonMetadata(metadata);
}

function getDefaultCoordinateSpace() {
  return makeCoordinateSpace(
      {names: ['x', 'y', 'z'], units: ['m', 'm', 'm'], scales: Float64Array.of(1e-9, 1e-9, 1e-9)});
}

export function getShardedMeshSource(chunkManager: ChunkManager, parameters: MeshSourceParameters, credentialsProvider: SpecialProtocolCredentialsProvider) {
  return chunkManager.getChunkSource(GrapheneMeshSource, {parameters, credentialsProvider});
}

async function getMeshSource(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string) {
      console.log('getMeshSource');
  const {metadata, segmentPropertyMap} =
      await getMeshMetadata(chunkManager, undefined, url);
  if (metadata === undefined) {
    return {
      source: getLegacyMeshSource(chunkManager, credentialsProvider, {
        manifestUrl: url,//parseSpecialUrl(url, credentialsProvider),
        fragmentUrl: url,//parseSpecialUrl(url, credentialsProvider),
        lod: 0,
        sharding: undefined,
        verifyMesh: false,
      }),
      transform: mat4.create(),
      segmentPropertyMap
    };
  }
  // TODO: what is this
  // let vertexPositionFormat: VertexPositionFormat;
  // const {vertexQuantizationBits} = metadata;
  // if (vertexQuantizationBits === 10) {
  //   vertexPositionFormat = VertexPositionFormat.uint10;
  // } else if (vertexQuantizationBits === 16) {
  //   vertexPositionFormat = VertexPositionFormat.uint16;
  // } else {
  //   throw new Error(`Invalid vertex quantization bits: ${vertexQuantizationBits}`);
  // }
  return {
    source: getShardedMeshSource(chunkManager, {
      manifestUrl: url,//parseSpecialUrl(url, credentialsProvider),
      fragmentUrl: url,//parseSpecialUrl(url, credentialsProvider),
      lod: 0,
      sharding: metadata.sharding,
      verifyMesh: false,
    }, credentialsProvider)
    /*chunkManager.getChunkSource(MultiscaleMeshSource, {
      credentialsProvider,
      parameters: {url, metadata},
      format: {
        fragmentRelativeVertices: true,
        vertexPositionFormat,
      }
    })*/,
    transform: metadata.transform,
    segmentPropertyMap,
  };
}

async function getSkeletonSource(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string) {
  const {metadata, segmentPropertyMap} =
      await getSkeletonMetadata(chunkManager, credentialsProvider, url);
  return {
    source: chunkManager.getChunkSource(GrapheneSkeletonSource, {
      credentialsProvider,
      parameters: {
        url,
        metadata,
      },
    }),
    transform: metadata.transform,
    segmentPropertyMap,
  };
}

function getJsonMetadata(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string): Promise<any> {
  return chunkManager.memoize.getUncounted(
      {'type': 'graphene:metadata', url, credentialsProvider: getObjectId(credentialsProvider)},
      async () => {
        return await cancellableFetchSpecialOk(
            credentialsProvider, `${url}/info`, {}, responseJson);
      });
}

function getSubsourceToModelSubspaceTransform(info: MultiscaleVolumeInfo) {
  const m = mat4.create();
  const resolution = info.scales[0].resolution;
  for (let i = 0; i < 3; ++i) {
    m[5 * i] = 1 / resolution[i];
  }
  return m;
}

async function getVolumeDataSource(
    options: GetDataSourceOptions, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string, metadata: any): Promise<DataSource> {
      console.log(url, metadata);
  const info = parseMultiscaleVolumeInfo(metadata, url);
  const volume = new GrapheneMultiscaleVolumeChunkSource(
      options.chunkManager, credentialsProvider, url, info);
  const {modelSpace} = info;
  const subsources: DataSubsourceEntry[] = [
    {
      id: 'default',
      default: true,
      subsource: {volume},
    },
    {
      id: 'bounds',
      default: true,
      subsource: {
        staticAnnotations: makeDataBoundsBoundingBoxAnnotationSet(modelSpace.bounds),
      },
    },
  ];
  if (info.segmentPropertyMap !== undefined) {
    const mapUrl = resolvePath(url, info.segmentPropertyMap);
    const metadata = await getJsonMetadata(options.chunkManager, credentialsProvider, mapUrl);
    const segmentPropertyMap =
        getSegmentPropertyMap(options.chunkManager, credentialsProvider, metadata, mapUrl);
    subsources.push({
      id: 'properties',
      default: true,
      subsource: {segmentPropertyMap},
    });
  }
  if (info.mesh !== undefined) {
    const meshUrl = resolvePath(info.dataUrl, info.mesh);
    const {source: meshSource, transform} =
        await getMeshSource(options.chunkManager, credentialsProvider, meshUrl);
    const subsourceToModelSubspaceTransform = getSubsourceToModelSubspaceTransform(info);
    mat4.multiply(subsourceToModelSubspaceTransform, subsourceToModelSubspaceTransform, transform);
    subsources.push({
      id: 'mesh',
      default: true,
      subsource: {mesh: meshSource},
      subsourceToModelSubspaceTransform,
    });
  }
  if (info.skeletons !== undefined) {
    const skeletonsUrl = resolvePath(url, info.skeletons);
    const {source: skeletonSource, transform} =
        await getSkeletonSource(options.chunkManager, credentialsProvider, skeletonsUrl);
    const subsourceToModelSubspaceTransform = getSubsourceToModelSubspaceTransform(info);
    mat4.multiply(subsourceToModelSubspaceTransform, subsourceToModelSubspaceTransform, transform);
    subsources.push({
      id: 'skeletons',
      default: true,
      subsource: {mesh: skeletonSource},
      subsourceToModelSubspaceTransform,
    });
  }
  return {modelTransform: makeIdentityTransform(modelSpace), subsources};
}

async function getSkeletonsDataSource(
    options: GetDataSourceOptions, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string): Promise<DataSource> {
  const {source: skeletons, transform, segmentPropertyMap} =
      await getSkeletonSource(options.chunkManager, credentialsProvider, url);
  const subsources: DataSubsourceEntry[] = [
    {
      id: 'default',
      default: true,
      subsource: {mesh: skeletons},
      subsourceToModelSubspaceTransform: transform,
    },
  ];
  if (segmentPropertyMap !== undefined) {
    const mapUrl = resolvePath(url, segmentPropertyMap);
    const metadata = await getJsonMetadata(options.chunkManager, credentialsProvider, mapUrl);
    const segmentPropertyMapData =
        getSegmentPropertyMap(options.chunkManager, credentialsProvider, metadata, mapUrl);
    subsources.push({
      id: 'properties',
      default: true,
      subsource: {segmentPropertyMap: segmentPropertyMapData},
    });
  }
  return {
    modelTransform: makeIdentityTransform(getDefaultCoordinateSpace()),
    subsources,
  };
}

function parseKeyAndShardingSpec(url: string, obj: any) {
  verifyObject(obj);
  return {
    url: resolvePath(url, verifyObjectProperty(obj, 'key', verifyString)),
    sharding: verifyObjectProperty(obj, 'sharding', parseShardingParameters),
  };
}

function parseAnnotationPropertySpec(obj: unknown): AnnotationPropertySpec {
  verifyObject(obj);
  const identifier = verifyObjectProperty(obj, 'id', parseAnnotationPropertyId);
  const type = verifyObjectProperty(obj, 'type', parseAnnotationPropertyType);
  const description = verifyOptionalObjectProperty(obj, 'description', verifyString);
  let defaultValue = 0;
  return {type, identifier, description, default: defaultValue} as AnnotationPropertySpec;
}

function parseAnnotationPropertySpecs(obj: unknown) {
  const properties = parseArray(obj, parseAnnotationPropertySpec);
  ensureUniqueAnnotationPropertyIds(properties);
  return properties;
}

interface AnnotationSpatialIndexLevelMetadata {
  parameters: AnnotationSpatialIndexSourceParameters;
  limit: number;
  spec: AnnotationGeometryChunkSpecification;
}

class AnnotationMetadata {
  coordinateSpace: CoordinateSpace;
  parameters: AnnotationSourceParameters;
  spatialIndices: AnnotationSpatialIndexLevelMetadata[];
  constructor(public url: string, metadata: any) {
    verifyObject(metadata);
    const baseCoordinateSpace =
        verifyObjectProperty(metadata, 'dimensions', coordinateSpaceFromJson);
    const {rank} = baseCoordinateSpace;
    const lowerBounds = verifyObjectProperty(
        metadata, 'lower_bound',
        boundJson => parseFixedLengthArray(new Float64Array(rank), boundJson, verifyFiniteFloat));
    const upperBounds = verifyObjectProperty(
        metadata, 'upper_bound',
        boundJson => parseFixedLengthArray(new Float64Array(rank), boundJson, verifyFiniteFloat));
    this.coordinateSpace = makeCoordinateSpace({
      rank,
      names: baseCoordinateSpace.names,
      units: baseCoordinateSpace.units,
      scales: baseCoordinateSpace.scales,
      boundingBoxes: [makeIdentityTransformedBoundingBox({lowerBounds, upperBounds})],
    });
    this.parameters = {
      type: verifyObjectProperty(
          metadata, 'annotation_type', typeObj => verifyEnumString(typeObj, AnnotationType)),
      rank,
      relationships: verifyObjectProperty(
          metadata, 'relationships',
          relsObj => parseArray(
              relsObj,
              relObj => {
                const common = parseKeyAndShardingSpec(url, relObj);
                const name = verifyObjectProperty(relObj, 'id', verifyString);
                return {...common, name};
              })),
      properties: verifyObjectProperty(metadata, 'properties', parseAnnotationPropertySpecs),
      byId: verifyObjectProperty(metadata, 'by_id', obj => parseKeyAndShardingSpec(url, obj)),
    };
    this.spatialIndices = verifyObjectProperty(
        metadata, 'spatial',
        spatialObj => parseArray(spatialObj, levelObj => {
          const common: AnnotationSpatialIndexSourceParameters =
              parseKeyAndShardingSpec(url, levelObj);
          const gridShape = verifyObjectProperty(
              levelObj, 'grid_shape',
              j => parseFixedLengthArray(new Float32Array(rank), j, verifyPositiveInt));
          const chunkShape = verifyObjectProperty(
              levelObj, 'chunk_size',
              j => parseFixedLengthArray(new Float32Array(rank), j, verifyFinitePositiveFloat));
          const limit = verifyObjectProperty(levelObj, 'limit', verifyPositiveInt);
          const gridShapeInVoxels = new Float32Array(rank);
          for (let i = 0; i < rank; ++i) {
            gridShapeInVoxels[i] = gridShape[i] * chunkShape[i];
          }
          const chunkToMultiscaleTransform = matrix.createIdentity(Float32Array, rank + 1);
          for (let i = 0; i < rank; ++i) {
            chunkToMultiscaleTransform[(rank + 1) * rank + i] = lowerBounds[i];
          }
          const spec: AnnotationGeometryChunkSpecification = {
            limit,
            chunkToMultiscaleTransform,
            ...makeSliceViewChunkSpecification({
              rank,
              chunkDataSize: chunkShape,
              upperVoxelBound: gridShapeInVoxels,
            })
          };
          spec.upperChunkBound = gridShape;
          return {
            parameters: common,
            spec,
            limit,
          };
        }));
    this.spatialIndices.reverse();
  }
}

async function getAnnotationDataSource(
    options: GetDataSourceOptions, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string, metadata: any): Promise<DataSource> {
  const info = new AnnotationMetadata(url, metadata);
  const dataSource: DataSource = {
    modelTransform: makeIdentityTransform(info.coordinateSpace),
    subsources: [
      {
        id: 'default',
        default: true,
        subsource: {
          annotation: options.chunkManager.getChunkSource(GrapheneAnnotationSource, {
            credentialsProvider,
            metadata: info,
            parameters: info.parameters,
          }),
        }
      },
    ],
  };
  return dataSource;
}

async function getMeshDataSource(
    options: GetDataSourceOptions, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string): Promise<DataSource> {
  const {source: mesh, transform, segmentPropertyMap} =
      await getMeshSource(options.chunkManager, credentialsProvider, url);
  const subsources: DataSubsourceEntry[] = [
    {
      id: 'default',
      default: true,
      subsource: {mesh},
      subsourceToModelSubspaceTransform: transform,
    },
  ];
  if (segmentPropertyMap !== undefined) {
    const mapUrl = resolvePath(url, segmentPropertyMap);
    const metadata = await getJsonMetadata(options.chunkManager, credentialsProvider, mapUrl);
    const segmentPropertyMapData =
        getSegmentPropertyMap(options.chunkManager, credentialsProvider, metadata, mapUrl);
    subsources.push({
      id: 'properties',
      default: true,
      subsource: {segmentPropertyMap: segmentPropertyMapData},
    });
  }

  return {
    modelTransform: makeIdentityTransform(getDefaultCoordinateSpace()),
    subsources,
  };
}

function parseInlinePropertyMap(data: unknown): InlineSegmentPropertyMap {
  verifyObject(data);
  const ids = verifyObjectProperty(data, 'ids', verifyStringArray);
  const properties = verifyObjectProperty(
      data, 'properties',
      propertiesObj => parseArray(propertiesObj, (propertyObj): InlineSegmentProperty => {
        verifyObject(propertyObj);
        const id = verifyObjectProperty(propertyObj, 'id', verifyString);
        const description = verifyOptionalObjectProperty(propertyObj, 'description', verifyString);
        const type = verifyObjectProperty(propertyObj, 'type', type => {
          if (type !== 'label' && type !== 'description' && type !== 'string') {
            throw new Error(`Invalid property type: ${JSON.stringify(type)}`);
          }
          return type;
        });
        const values = verifyObjectProperty(propertyObj, 'values', valuesObj => {
          verifyStringArray(valuesObj);
          if (valuesObj.length !== ids.length)
            throw new Error(`Expected ${ids.length} values, but received: ${valuesObj.length}`);
          return valuesObj;
        });
        return {id, description, type, values};
      }));
  return {ids, properties};
}

export const GrapheneIndexedSegmentPropertySource = WithParameters(
    WithCredentialsProvider<SpecialProtocolCredentials>()(IndexedSegmentPropertySource),
    IndexedSegmentPropertySourceParameters);

function parseIndexedPropertyMap(data: unknown): {
  sharding: ShardingParameters|undefined,
  properties: readonly Readonly<IndexedSegmentProperty>[]
} {
  verifyObject(data);
  const sharding = verifyObjectProperty(data, 'sharding', parseShardingParameters);
  const properties = verifyObjectProperty(
      data, 'properties',
      propertiesObj => parseArray(propertiesObj, (propertyObj): IndexedSegmentProperty => {
        const id = verifyObjectProperty(propertyObj, 'id', verifyString);
        const description = verifyOptionalObjectProperty(propertyObj, 'description', verifyString);
        const type = verifyObjectProperty(propertyObj, 'type', type => {
          if (type !== 'string') {
            throw new Error(`Invalid property type: ${JSON.stringify(type)}`);
          }
          return type;
        });
        return {id, description, type};
      }));
  return {sharding, properties};
}

function getSegmentPropertyMap(
    chunkManager: Borrowed<ChunkManager>, credentialsProvider: SpecialProtocolCredentialsProvider,
    data: unknown, url: string): SegmentPropertyMap {
  try {
    const t = verifyObjectProperty(data, '@type', verifyString);
    if (t !== 'neuroglancer_segment_properties') {
      throw new Error(`Unsupported segment property map type: ${JSON.stringify(t)}`);
    }
    const inlineProperties = verifyOptionalObjectProperty(data, 'inline', parseInlinePropertyMap);
    const indexedProperties = verifyOptionalObjectProperty(data, 'indexed', indexedObj => {
      const {sharding, properties} = parseIndexedPropertyMap(indexedObj);
      return chunkManager.getChunkSource(
          GrapheneIndexedSegmentPropertySource,
          {credentialsProvider, properties, parameters: {sharding, url}});
    });
    return new SegmentPropertyMap({inlineProperties, indexedProperties});
  } catch (e) {
    throw new Error(`Error parsing segment property map: ${e.message}`);
  }
}

async function getSegmentPropertyMapDataSource(
    options: GetDataSourceOptions, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string, metadata: unknown): Promise<DataSource> {
  options;
  return {
    modelTransform: makeIdentityTransform(emptyValidCoordinateSpace),
    subsources: [
      {
        id: 'default',
        default: true,
        subsource: {
          segmentPropertyMap:
              getSegmentPropertyMap(options.chunkManager, credentialsProvider, metadata, url)
        },
      },
    ],
  };
}

const urlPattern = /^([^#]*)(?:#(.*))?$/;

function parseProviderUrl(providerUrl: string) {
  let [, url, fragment] = providerUrl.match(urlPattern)!;
  if (url.endsWith('/')) {
    url = url.substring(0, url.length - 1);
  }
  const parameters = parseQueryStringParameters(fragment || '');
  return {url, parameters};
}

function unparseProviderUrl(url: string, parameters: any) {
  const fragment = unparseQueryStringParameters(parameters);
  if (fragment) {
    url += `#${fragment}`;
  }
  return url;
}

export class GrapheneDataSource extends DataSourceProvider {
  get description() {
    return 'Graphene file-backed data source';
  }

  normalizeUrl(options: NormalizeUrlOptions): string {
    const {url, parameters} = parseProviderUrl(options.providerUrl);
    return options.providerProtocol + '://' + unparseProviderUrl(url, parameters);
  }

  convertLegacyUrl(options: ConvertLegacyUrlOptions): string {
    const {url, parameters} = parseProviderUrl(options.providerUrl);
    if (options.type === 'mesh') {
      parameters['type'] = 'mesh';
    }
    return options.providerProtocol + '://' + unparseProviderUrl(url, parameters);
  }

  get(options: GetDataSourceOptions): Promise<DataSource> {
    const {url: providerUrl, parameters} = parseProviderUrl(options.providerUrl);
    return options.chunkManager.memoize.getUncounted(
        {'type': 'graphene:get', providerUrl, parameters}, async(): Promise<DataSource> => {
          const {url, credentialsProvider} =
              parseSpecialUrl(providerUrl, options.credentialsManager);
          let metadata: any;
          try {
            metadata = await getJsonMetadata(options.chunkManager, credentialsProvider, url);
          } catch (e) {
            if (isNotFoundError(e)) {
              if (parameters['type'] === 'mesh') {
                return await getMeshDataSource(options, credentialsProvider, url);
              }
            }
            throw e;
          }
          verifyObject(metadata);
          const redirect = verifyOptionalObjectProperty(metadata, 'redirect', verifyString);
          if (redirect !== undefined) {
            throw new RedirectError(redirect);
          }
          const t = verifyOptionalObjectProperty(metadata, '@type', verifyString);
          switch (t) {
            case 'neuroglancer_skeletons':
              return await getSkeletonsDataSource(options, credentialsProvider, url);
            case 'neuroglancer_multilod_draco':
            case 'neuroglancer_legacy_mesh':
              return await getMeshDataSource(options, credentialsProvider, url);
            case 'neuroglancer_annotations_v1':
              return await getAnnotationDataSource(options, credentialsProvider, url, metadata);
            case 'neuroglancer_segment_properties':
              return await getSegmentPropertyMapDataSource(
                  options, credentialsProvider, url, metadata);
            case 'neuroglancer_multiscale_volume':
            case undefined:
              return await getVolumeDataSource(options, credentialsProvider, url, metadata);
            default:
              throw new Error(`Invalid type: ${JSON.stringify(t)}`);
          }
        });
  }
  completeUrl(options: CompleteUrlOptions) {
    return completeHttpPath(
        options.credentialsManager, options.providerUrl, options.cancellationToken);
  }
}
