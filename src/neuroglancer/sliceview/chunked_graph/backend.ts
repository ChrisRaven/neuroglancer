/**
 * @license
 * Copyright 2018 The Neuroglancer Authors
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

import debounce from 'lodash/debounce';
import {cancelChunkDownload, startChunkDownload, withChunkManager} from 'neuroglancer/chunk_manager/backend';
import {ChunkPriorityTier, ChunkState} from 'neuroglancer/chunk_manager/base';
import {CoordinateTransform} from 'neuroglancer/coordinate_transform';
import {SharedDisjointUint64Sets} from 'neuroglancer/shared_disjoint_sets';
import {SliceViewChunk, SliceViewChunkSource} from 'neuroglancer/sliceview/backend';
import {RenderLayer as RenderLayerInterface, TransformedSource} from 'neuroglancer/sliceview/base';
import {CHUNKED_GRAPH_LAYER_RPC_ID, CHUNKED_GRAPH_SOURCE_UPDATE_ROOT_SEGMENTS_RPC_ID, ChunkedGraphChunkSource as ChunkedGraphChunkSourceInterface, ChunkedGraphChunkSpecification, RENDER_RATIO_LIMIT} from 'neuroglancer/sliceview/chunked_graph/base';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {mat4, vec3, vec3Key} from 'neuroglancer/util/geom';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {registerRPC, registerSharedObject, RPC, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';

const tempChunkDataSize = vec3.create();
const tempChunkPosition = vec3.create();

export class ChunkedGraphChunk extends SliceViewChunk {
  backendOnly = true;
  source: ChunkedGraphChunkSource|null = null;
  mappings: Map<string, Uint64[]|null>|null = null;
  chunkDataSize: vec3|null;
  constructor() {
    super();
  }

  updateRootSegments(rootSegments: Uint64Set) {
    let changed = false;
    for (const rootObjectId of rootSegments) {
      const key = rootObjectId.toString();
      if (!this.mappings!.has(key)) {
        changed = true;
        this.mappings!.set(key, null);
      }
    }
    return changed;
  }

  initializeChunkedGraphChunk(key: string, chunkGridPosition: vec3, rootSegments: Uint64Set) {
    super.initializeVolumeChunk(key, chunkGridPosition);
    this.chunkDataSize = null;
    this.mappings = new Map<string, Uint64[]|null>();
    this.systemMemoryBytes = 0;
    this.gpuMemoryBytes = 0;

    this.updateRootSegments(rootSegments);
  }

  downloadSucceeded() {
    this.systemMemoryBytes = 0;
    for (const supervoxelIds of this.mappings!.values()) {
      if (supervoxelIds !== null) {
        // Each supervoxel ID is a Uint64, consisting of two `number`s (8 Byte)
        this.systemMemoryBytes += 16 * supervoxelIds.length;
      }
    }
    this.queueManager.updateChunkState(this, ChunkState.SYSTEM_MEMORY_WORKER);
    if (this.priorityTier < ChunkPriorityTier.RECENT) {
      this.source!.chunkManager.scheduleUpdateChunkPriorities();
    }
    super.downloadSucceeded();
  }

  freeSystemMemory() {
    this.mappings = new Map<string, Uint64[]|null>();
  }
}

export async function decodeSupervoxelArray(
    chunk: ChunkedGraphChunk, rootObjectKeys: string[], data: Response) {
  const rootToLeavesMap = await data.json();
  rootObjectKeys.forEach(rootObjectKey => {
    const leaves = rootToLeavesMap[rootObjectKey];
    const final: Uint64[] = new Array(leaves.length);
    for (let i = 0; i < final.length; ++i) {
      final[i] = Uint64.parseString(leaves[i]);
    }
    chunk.mappings!.set(rootObjectKey, final);
  });
}


export class ChunkedGraphChunkSource extends SliceViewChunkSource implements
    ChunkedGraphChunkSourceInterface {
  spec: ChunkedGraphChunkSpecification;
  chunks: Map<string, ChunkedGraphChunk>;
  rootSegments: Uint64Set;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.spec = ChunkedGraphChunkSpecification.fromObject(options['spec']);
    this.rootSegments = rpc.get(options['rootSegments']);
  }

  getChunk(chunkGridPosition: vec3) {
    let key = vec3Key(chunkGridPosition);
    let chunk = <ChunkedGraphChunk>this.chunks.get(key);

    if (chunk === undefined) {
      chunk = this.getNewChunk_(ChunkedGraphChunk);
      chunk.initializeChunkedGraphChunk(key, chunkGridPosition, this.rootSegments);
      this.addChunk(chunk);
    } else {
      if (chunk.updateRootSegments(this.rootSegments)) {
        if (chunk.downloadCancellationToken !== undefined) {
          cancelChunkDownload(chunk);
        }
        this.chunkManager.queueManager.updateChunkState(chunk, ChunkState.DOWNLOADING);
        startChunkDownload(chunk);
      }
    }
    return chunk;
  }

  /**
   * Helper function for computing the voxel bounds of a chunk based on its chunkGridPosition.
   *
   * This assumes that the grid of chunk positions starts at this.baseVoxelOffset.  Chunks are
   * clipped to lie within upperVoxelBound, but are not clipped to lie within lowerVoxelBound.  (The
   * frontend code currently cannot handle chunks clipped at their lower corner, and the chunk
   * layout can generally be chosen so that lowerVoxelBound lies on a chunk boundary.)
   *
   * This sets chunk.chunkDataSize to a copy of the returned chunkDataSize if it differs from
   * this.spec.chunkDataSize; otherwise, it is set to this.spec.chunkDataSize.
   *
   * @returns A globally-allocated Vec3 containing the chunk corner position in voxel coordinates.
   * The returned Vec3 will be invalidated by any subsequent call to this method, even on a
   * different VolumeChunkSource instance.
   */
  computeChunkBounds(chunk: ChunkedGraphChunk) {
    let {spec} = this;
    let {upperVoxelBound} = spec;

    let origChunkDataSize = spec.chunkDataSize;
    let newChunkDataSize = tempChunkDataSize;

    // Chunk start position in voxel coordinates.
    let chunkPosition =
        vec3.multiply(tempChunkPosition, chunk.chunkGridPosition, origChunkDataSize);

    // Specifies whether the chunk only partially fits within the data bounds.
    let partial = false;
    for (let i = 0; i < 3; ++i) {
      let upper = Math.min(upperVoxelBound[i], chunkPosition[i] + origChunkDataSize[i]);
      let size = newChunkDataSize[i] = upper - chunkPosition[i];
      if (size !== origChunkDataSize[i]) {
        partial = true;
      }
    }

    vec3.add(chunkPosition, chunkPosition, this.spec.baseVoxelOffset);

    if (partial) {
      chunk.chunkDataSize = vec3.clone(newChunkDataSize);
    } else {
      chunk.chunkDataSize = origChunkDataSize;
    }

    return chunkPosition;
  }
}
ChunkedGraphChunkSource.prototype.chunkConstructor = ChunkedGraphChunk;


const Base = withChunkManager(SharedObjectCounterpart);

@registerSharedObject(CHUNKED_GRAPH_LAYER_RPC_ID)
export class ChunkedGraphLayer extends Base implements RenderLayerInterface<SliceViewChunkSource> {
  rpcId: number;
  sources: ChunkedGraphChunkSource[][];
  layerChanged = new NullarySignal();
  transform = new CoordinateTransform();
  transformedSources: TransformedSource<SliceViewChunkSource>[][];
  transformedSourcesGeneration = -1;
  renderScaleTarget: WatchableValueInterface<number>;

  graphurl: string;
  rootSegments: Uint64Set;
  visibleSegments3D: Uint64Set;
  segmentEquivalences: SharedDisjointUint64Sets;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.graphurl = options['url'];
    this.rootSegments = <Uint64Set>rpc.get(options['rootSegments']);
    this.visibleSegments3D = <Uint64Set>rpc.get(options['visibleSegments3D']);
    this.segmentEquivalences = <SharedDisjointUint64Sets>rpc.get(options['segmentEquivalences']);
    this.renderScaleTarget = rpc.get(options['renderScaleTarget']);

    this.sources = new Array<ChunkedGraphChunkSource[]>();
    for (const alternativeIds of options['sources']) {
      const alternatives = new Array<ChunkedGraphChunkSource>();
      this.sources.push(alternatives);
      for (const sourceId of alternativeIds) {
        const source: ChunkedGraphChunkSource = rpc.get(sourceId);
        this.registerDisposer(source.addRef());
        alternatives.push(source);
      }
    }
    mat4.copy(this.transform.transform, options['transform']);
    this.transform.changed.add(this.layerChanged.dispatch);

    this.registerDisposer(this.rootSegments.changed.add(() => {
      this.chunkManager.scheduleUpdateChunkPriorities();
    }));

    this.registerDisposer(this.chunkManager.recomputeChunkPriorities.add(() => {
      this.debouncedupdateDisplayState();
    }));
  }

  get url() {
    return this.graphurl;
  }

  // Used for the sliceview to set a limit on when to
  // make get_leaves to the ChunkedGraph
  get renderRatioLimit() {
    return RENDER_RATIO_LIMIT;
  }

  private debouncedupdateDisplayState = debounce(() => {
    this.updateDisplayState();
  }, 100);

  private forEachSelectedRootWithLeaves(
      callback: (rootObjectKey: string, leaves: Uint64[]) => void) {
    for (const alternative of this.sources) {
      for (const source of alternative) {
        for (const chunk of source.chunks.values()) {
          if (chunk.state === ChunkState.SYSTEM_MEMORY_WORKER &&
              chunk.priorityTier < ChunkPriorityTier.RECENT) {
            for (const [rootObjectKey, leaves] of chunk.mappings!) {
              if (this.rootSegments.has(Uint64.parseString(rootObjectKey)) && leaves !== null) {
                callback(rootObjectKey, leaves);
              }
            }
          }
        }
      }
    }
  }

  private updateDisplayState() {
    const visibleLeaves = new Map<string, Uint64Set>();
    const capacities = new Map<string, number>();

    // Reserve
    this.forEachSelectedRootWithLeaves((rootObjectKey, leaves) => {
      if (!capacities.has(rootObjectKey)) {
        capacities.set(rootObjectKey, leaves.length);
      } else {
        capacities.set(rootObjectKey, capacities.get(rootObjectKey)! + leaves.length);
      }
    });

    // Collect unique leaves
    this.forEachSelectedRootWithLeaves((rootObjectKey, leaves) => {
      if (!visibleLeaves.has(rootObjectKey)) {
        visibleLeaves.set(rootObjectKey, new Uint64Set());
        visibleLeaves.get(rootObjectKey)!.reserve(capacities.get(rootObjectKey)!);
        visibleLeaves.get(rootObjectKey)!.add(Uint64.parseString(rootObjectKey));
      }
      visibleLeaves.get(rootObjectKey)!.add(leaves);
    });

    for (const [root, leaves] of visibleLeaves) {
      // TODO: Delete segments not visible anymore from segmentEquivalences - requires a faster data
      // structure, though.

      /*if (this.segmentEquivalences.has(Uint64.parseString(root))) {
        this.segmentEquivalences.delete([...this.segmentEquivalences.setElements(Uint64.parseString(root))].filter(x
      => !leaves.has(x) && !this.visibleSegments3D.has(x)));
      }*/

      this.segmentEquivalences.link(
          Uint64.parseString(root), [...leaves].filter(x => !this.segmentEquivalences.has(x)));
    }
  }
}

registerRPC(CHUNKED_GRAPH_SOURCE_UPDATE_ROOT_SEGMENTS_RPC_ID, function(x: any) {
  const chunkedGraphChunkSource = <ChunkedGraphChunkSource>this.get(x.id);
  chunkedGraphChunkSource.rootSegments = this.get(x.rootSegments);
});
