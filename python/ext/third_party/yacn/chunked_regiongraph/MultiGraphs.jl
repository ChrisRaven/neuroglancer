module MultiGraphs
using LightGraphs
using DataStructures
using Iterators
using Utils

function setpush!{E}(x::Vector{E},y::E)
	if !(y in x)
		push!(x,y)
	end
end

function setpush!{E}(x::Set{E},y::E)
	push!(x,y)
end

function setdelete!{E}(x::Vector{E},y::E)
	deleteat!(x,findin(x,(y,)))
end
function setdelete!{E}(x::Set{E},y::E)
	delete!(x,y)
end


#TODO: garbage collection

type MultiGraph{V,E}
	g::LightGraphs.Graph
	vertex_map::Dict{V,Int}
	inverse_vertex_map::Dict{Int,V}
	edge_map::Dict{Tuple{Int,Int},Vector{E}}
end
function MultiGraph(V,E)
	return MultiGraph{V,E}(LightGraphs.Graph(), Dict{V,Int}(),Dict{Int,V}(),Dict{Tuple{Int,Int},Vector{E}}(E[]))
end
function add_vertex!(G::MultiGraph, v)
	LightGraphs.add_vertex!(G.g)
	G.vertex_map[v] = nv(G.g)
	G.inverse_vertex_map[nv(G.g)] = v
end

function delete_vertex!(G::MultiGraph,vertex)
	u=G.vertex_map[vertex]
	for v in collect(neighbors(G.g,u))
		rem_edge!(G.g,u,v)
		delete!(G.edge_map, unordered(u,v))
	end
	delete!(G.vertex_map,vertex)
	delete!(G.inverse_vertex_map,u)
	#todo: delete incident edges
end

function delete_edge!(G::MultiGraph,U,V,e)
	e=unordered(e)
	u=G.vertex_map[U]
	v=G.vertex_map[V]
	uv=unordered(u,v)
	if has_edge(G.g,u,v)
		setdelete!(G.edge_map[uv],e)
		if length(G.edge_map[uv]) == 0
			rem_edge!(G.g,u,v)
		 end
	end
end

function add_edge!{Vert,E}(G::MultiGraph{Vert,E},U,V,e)
	e=unordered(e)
	u=G.vertex_map[U]
	v=G.vertex_map[V]
	uv = unordered(u,v)
	LightGraphs.add_edge!(G.g,u,v)
	if !haskey(G.edge_map,uv)
		G.edge_map[uv]=E[e]
	else
		setpush!(G.edge_map[uv],e)
	end
end

function incident_edges(G::MultiGraph, U)
	u=G.vertex_map[U]
	return chain([G.edge_map[unordered(u,v)] for v in neighbors(G.g, u)]...)
end

function connected_components{V,E}(G::MultiGraph{V,E}, Vertices)
	g=G.g
	vertices = map(x->G.vertex_map[x],Vertices)
	visited=Set{Int}()
	sizehint!(visited, length(vertices))
	components=Array{Int,1}[]
	to_visit=Set{Int}()#Set{Int}(Int[v])

	for v in vertices
		if !(v in visited)
			next_component=Int[]
			empty!(to_visit)
			push!(to_visit,v)

			while length(to_visit) > 0
				x=pop!(to_visit)
				push!(next_component,x)
				push!(visited,x)
				for n in neighbors(g,x)
					if !(n in visited)
						push!(to_visit,n)
					end
				end
			end
			push!(components, next_component)
		end
	end
	#@assert length(vertices) == sum(map(length,components))
	return Array{V,1}[map(x->G.inverse_vertex_map[x],y) for y in components]
end





type SimpleGraph{V}
	g::LightGraphs.Graph
	vertex_map::Dict{V,Int}
	inverse_vertex_map::Dict{Int,V}

end
function SimpleGraph(V)
	return SimpleGraph{V}(LightGraphs.Graph(), Dict{V,Int}(),Dict{Int,V}())
end
function add_vertex!(G::SimpleGraph, v)
	if !(haskey(G.vertex_map,v))
		LightGraphs.add_vertex!(G.g)
		G.vertex_map[v] = nv(G.g)
		G.inverse_vertex_map[nv(G.g)] = v
	end
end

function delete_vertex!(G::SimpleGraph,vertex)
	u=G.vertex_map[vertex]
	for v in collect(neighbors(G.g,u))
		rem_edge!(G.g,u,v)
	end
	delete!(G.vertex_map,vertex)
	delete!(G.inverse_vertex_map,u)
end

function delete_edge!(G::SimpleGraph,U,V)
	u=G.vertex_map[U]
	v=G.vertex_map[V]
	rem_edge!(G.g,u,v)
end

function add_edge!(G::SimpleGraph,U,V)
	u=G.vertex_map[U]
	v=G.vertex_map[V]
	LightGraphs.add_edge!(G.g,u,v)
end

function induced_edges{V}(G::SimpleGraph{V},Us)
	us = Int[G.vertex_map[U] for U in Us if haskey(G.vertex_map,U)]
	us_set = Set{Int}(us)

	ret = Tuple{V,V}[]
	for u in us
		for v in neighbors(G.g,u)
			if v in us_set && u < v
				push!(ret,(G.inverse_vertex_map[u],G.inverse_vertex_map[v]))
			end
		end
	end
	return ret
end

end
