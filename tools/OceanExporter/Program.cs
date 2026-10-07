using System.IO.Compression;
using System.Text;
using System.Text.Json;
using CodeWalker.GameFiles;
using CodeWalker.Utils;
using CodeWalker;
using SharpDX;

// Converts a FiveM/GTA V map resource (ydr/ydd/yft/ytd/ytyp/ymap) into a glTF scene + room metadata
// usable by the web viewer.
//   usage: OceanExporter <streamDir> <outDir> [--radius 400]
namespace OceanExporter;

static class Program
{
    static string SrcDir, OutDir;
    static float Radius = 400f;

    static readonly Dictionary<uint, DrawableBase> Drawables = new();
    static readonly Dictionary<uint, Dictionary<uint, Drawable>> DrawableDicts = new();
    static readonly Dictionary<string, Texture> Textures = new(StringComparer.OrdinalIgnoreCase);
    static readonly Dictionary<uint, Archetype> Archetypes = new();
    static readonly List<YmapFile> Ymaps = new();
    static int MissingInMlo;

    static int Main(string[] args)
    {
        if (args.Length < 2) { Console.WriteLine("usage: OceanExporter <streamDir> <outDir> [--radius N]"); return 1; }
        SrcDir = args[0]; OutDir = args[1];
        for (int i = 2; i < args.Length; i++)
            if (args[i] == "--radius") Radius = float.Parse(args[++i], System.Globalization.CultureInfo.InvariantCulture);

        Directory.CreateDirectory(OutDir);
        Directory.CreateDirectory(Path.Combine(OutDir, "textures"));

        var files = Directory.GetFiles(SrcDir, "*.*", SearchOption.AllDirectories);
        foreach (var f in files) JenkIndex.Ensure(Path.GetFileNameWithoutExtension(f).ToLowerInvariant());

        LoadAll(files);
        var instances = CollectInstances(out var mloInfos);
        Console.WriteLine($"instances resolved: {instances.Count} (interior: {instances.Count(i => i.Mlo >= 0)}), interior entities missing (vanilla GTA props): {MissingInMlo}");
        new GltfBuilder(OutDir).Build(instances, mloInfos);
        return 0;
    }

    static void Try(string f, Action a)
    {
        try { a(); } catch (Exception e) { Console.WriteLine($"  !! {Path.GetFileName(f)}: {e.Message}"); }
    }

    static void LoadAll(string[] files)
    {
        foreach (var f in files)
        {
            var ext = Path.GetExtension(f).ToLowerInvariant();
            var name = Path.GetFileNameWithoutExtension(f).ToLowerInvariant();
            var hash = JenkHash.GenHash(name);
            switch (ext)
            {
                case ".ydr":
                    Try(f, () => { var y = new YdrFile(); y.Load(File.ReadAllBytes(f)); if (y.Drawable != null) Drawables[hash] = y.Drawable; });
                    break;
                case ".yft":
                    Try(f, () => { var y = new YftFile(); y.Load(File.ReadAllBytes(f)); var d = y.Fragment?.Drawable; if (d != null) Drawables[hash] = d; });
                    break;
                case ".ydd":
                    Try(f, () => { var y = new YddFile(); y.Load(File.ReadAllBytes(f)); if (y.Dict != null) DrawableDicts[hash] = y.Dict; });
                    break;
                case ".ytd":
                    Try(f, () =>
                    {
                        var y = new YtdFile(); y.Load(File.ReadAllBytes(f));
                        var dict = y.TextureDict?.Dict; if (dict == null) return;
                        foreach (var t in dict.Values) AddTexture(t);
                    });
                    break;
                case ".ytyp":
                    Try(f, () =>
                    {
                        var y = new YtypFile(); y.Load(File.ReadAllBytes(f));
                        if (y.AllArchetypes != null) foreach (var a in y.AllArchetypes) Archetypes[a._BaseArchetypeDef.name] = a;
                    });
                    break;
                case ".ymap":
                    Try(f, () => { var y = new YmapFile(); y.Load(File.ReadAllBytes(f)); y.Name = name; Ymaps.Add(y); });
                    break;
            }
        }
        // embedded textures of drawables are also candidates
        foreach (var d in Drawables.Values) AddEmbedded(d);
        foreach (var dd in DrawableDicts.Values) foreach (var d in dd.Values) AddEmbedded(d);

        Console.WriteLine($"drawables: {Drawables.Count}, ydd: {DrawableDicts.Count}, textures: {Textures.Count}, archetypes: {Archetypes.Count}, ymaps: {Ymaps.Count}");
    }

    static void AddEmbedded(DrawableBase d)
    {
        var dict = d?.ShaderGroup?.TextureDictionary?.Dict;
        if (dict != null) foreach (var t in dict.Values) AddTexture(t);
    }

    static void AddTexture(Texture t)
    {
        if (t?.Name == null) return;
        if (!Textures.TryGetValue(t.Name, out var ex) || ex.Width < t.Width) Textures[t.Name] = t;
    }

    public static Texture FindTexture(string name)
    {
        if (string.IsNullOrEmpty(name)) return null;
        return Textures.TryGetValue(name, out var t) ? t : null;
    }

    public static DrawableBase FindDrawable(Archetype arch)
    {
        var h = arch.Hash.Hash != 0 ? arch.Hash.Hash : arch._BaseArchetypeDef.name.Hash;
        if (arch.DrawableDict.Hash != 0 && DrawableDicts.TryGetValue(arch.DrawableDict.Hash, out var dd) && dd.TryGetValue(h, out var dr)) return dr;
        if (Drawables.TryGetValue(h, out var d)) return d;
        if (Drawables.TryGetValue(arch._BaseArchetypeDef.name.Hash, out d)) return d;
        return null;
    }

    public class Instance
    {
        public string Name;
        public DrawableBase Drawable;
        public Vector3 Position;
        public Quaternion Orientation;
        public Vector3 Scale;
        public int Mlo = -1;    // index of the MLO this entity belongs to (-1 = exterior)
        public int Room = -1;   // room index inside the MLO
    }

    public class MloInfo
    {
        public string Name;
        public Vector3 Position;
        public Quaternion Orientation;
        public MloArchetype Arch;
    }

    static List<Instance> CollectInstances(out List<MloInfo> mlos)
    {
        var list = new List<Instance>();
        mlos = new List<MloInfo>();
        var missing = new Dictionary<string, int>();

        // scene centre = the biggest MLO; MLOs further than Radius from it are unrelated and skipped
        Vector3 centre = Vector3.Zero;
        int best = -1;
        foreach (var ymap in Ymaps)
            foreach (var e in ymap.AllEntities ?? Array.Empty<YmapEntityDef>())
                if (Archetypes.TryGetValue(e._CEntityDef.archetypeName, out var a) && a is MloArchetype m && (m.entities?.Length ?? 0) > best)
                { best = m.entities?.Length ?? 0; centre = e.Position; }

        // pass 1: MLO interiors
        foreach (var ymap in Ymaps)
        {
            if (ymap.AllEntities == null) continue;
            foreach (var e in ymap.AllEntities)
            {
                if (!Archetypes.TryGetValue(e._CEntityDef.archetypeName, out var arch) || arch is not MloArchetype mloa) continue;
                if (Vector3.Distance(e.Position, centre) > Radius) { Console.WriteLine($"skip far MLO {mloa.Name} @ {e.Position}"); continue; }
                e.SetArchetype(mloa);
                var mi = new MloInfo { Name = mloa.Name, Position = e.Position, Orientation = e.Orientation, Arch = mloa };
                int mloIndex = mlos.Count;
                mlos.Add(mi);
                Console.WriteLine($"MLO {mloa.Name} in {ymap.Name} @ {e.Position}  rooms={mloa.rooms?.Length ?? 0} entities={mloa.entities?.Length ?? 0} sets={mloa.entitySets?.Length ?? 0}");

                var roomOf = new Dictionary<int, int>();
                if (mloa.rooms != null)
                    for (int r = 0; r < mloa.rooms.Length; r++)
                        if (mloa.rooms[r].AttachedObjects != null)
                            foreach (var idx in mloa.rooms[r].AttachedObjects) roomOf[(int)idx] = r;

                var inst = e.MloInstance;
                if (inst?.Entities != null)
                    for (int i = 0; i < inst.Entities.Length; i++)
                        AddEntity(list, inst.Entities[i], missing, mloIndex, roomOf.TryGetValue(i, out var ri) ? ri : -1);
                if (inst?.EntitySets != null)
                    foreach (var set in inst.EntitySets)
                    {
                        Console.WriteLine($"  entity set {set.EntitySet?.Name} visible={set.Visible} count={set.Entities?.Count}");
                        if (!set.Visible || set.Entities == null) continue;
                        for (int i = 0; i < set.Entities.Count; i++)
                        {
                            int room = -1;
                            var locs = set.EntitySet?.Locations;
                            if (locs != null && i < locs.Length) room = (int)locs[i];
                            AddEntity(list, set.Entities[i], missing, mloIndex, room);
                        }
                    }
            }
        }


        // pass 2: regular (exterior) entities near the MLO
        foreach (var ymap in Ymaps)
        {
            if (ymap.AllEntities == null) continue;
            int added = 0, total = 0;
            foreach (var e in ymap.AllEntities)
            {
                if (e.IsMlo) continue;
                total++;
                if (mlos.Count > 0 && Vector3.Distance(e.Position, centre) > Radius) continue;
                var lod = e._CEntityDef.lodLevel;
                if (lod != rage__eLodType.LODTYPES_DEPTH_HD && lod != rage__eLodType.LODTYPES_DEPTH_ORPHANHD) continue;
                if (AddEntity(list, e, missing, -1, -1)) added++;
            }
            if (total > 0) Console.WriteLine($"ymap {ymap.Name}: {added}/{total} entities");
        }

        if (missing.Count > 0)
            Console.WriteLine($"unresolved archetypes ({missing.Count}): " + string.Join(", ", missing.OrderByDescending(k => k.Value).Take(40).Select(k => $"{k.Key}x{k.Value}")));
        return list;
    }

    static bool AddEntity(List<Instance> list, YmapEntityDef e, Dictionary<string, int> missing, int mlo, int room)
    {
        var nameHash = e._CEntityDef.archetypeName;
        DrawableBase d = null;
        if (Archetypes.TryGetValue(nameHash, out var arch)) d = FindDrawable(arch);
        if (d == null) Drawables.TryGetValue(nameHash, out d);
        if (d == null)
        {
            var n = nameHash.ToString();
            missing[n] = missing.TryGetValue(n, out var c) ? c + 1 : 1;
            if (mlo >= 0) MissingInMlo++;
            return false;
        }
        list.Add(new Instance
        {
            Name = nameHash.ToString(), Drawable = d,
            Position = e.Position, Orientation = e.Orientation, Scale = e.Scale,
            Mlo = mlo, Room = room
        });
        return true;
    }
}

/// Minimal glTF 2.0 writer (separate .bin + PNG textures).
class GltfBuilder
{
    readonly string outDir;
    readonly MemoryStream bin = new();
    readonly List<object> bufferViews = new(), accessors = new(), meshes = new(), nodes = new(), materials = new(), textures = new(), images = new();
    readonly Dictionary<DrawableBase, int> meshIndex = new();
    readonly List<float> meshExtents = new();
    float meshExtent;
    readonly Dictionary<string, int> materialIndex = new();
    readonly Dictionary<string, int> textureIndex = new(StringComparer.OrdinalIgnoreCase);
    int texMissing, texFailed;
    readonly HashSet<string> missingTexNames = new();

    public GltfBuilder(string dir) { outDir = dir; }

    public void Build(List<Program.Instance> instances, List<Program.MloInfo> mlos)
    {
        Vector3 centre = mlos.Count > 0 ? mlos[0].Position : Vector3.Zero;
        var interiorNodes = new List<int>(); var exteriorNodes = new List<int>(); var doorNodes = new List<int>();
        var doorRx = new System.Text.RegularExpressions.Regex("(door|porte)(?!.*(frame|cadre))", System.Text.RegularExpressions.RegexOptions.IgnoreCase);

        foreach (var inst in instances)
        {
            int mesh = GetMesh(inst.Drawable, inst.Name);
            if (mesh < 0) continue;
            if (meshExtents[mesh] > 500f) { Console.WriteLine($"skip {inst.Name}: geometry {meshExtents[mesh]:F0}m from its origin"); continue; }
            var p = inst.Position - centre;
            var q = inst.Orientation;
            var node = new Dictionary<string, object>
            {
                ["name"] = inst.Name,
                ["mesh"] = mesh,
                ["translation"] = new[] { p.X, p.Y, p.Z },
                ["rotation"] = new[] { q.X, q.Y, q.Z, q.W },
                ["extras"] = new Dictionary<string, object> { ["mlo"] = inst.Mlo, ["room"] = inst.Room }
            };
            if (inst.Scale != Vector3.One) node["scale"] = new[] { inst.Scale.X, inst.Scale.Y, inst.Scale.Z };
            (doorRx.IsMatch(inst.Name) && !inst.Name.Contains("frame") && !inst.Name.Contains("cadre") && !inst.Name.Contains("bordure") ? doorNodes : inst.Mlo >= 0 ? interiorNodes : exteriorNodes).Add(nodes.Count);
            nodes.Add(node);
        }

        // root: GTA is Z-up, glTF is Y-up -> rotate -90deg around X
        float s = (float)Math.Sqrt(0.5);
        int root = nodes.Count;
        int ext = nodes.Count; nodes.Add(new Dictionary<string, object> { ["name"] = "exterior", ["children"] = exteriorNodes });
        int inter = nodes.Count; nodes.Add(new Dictionary<string, object> { ["name"] = "interior", ["children"] = interiorNodes });
        int doors = nodes.Count; nodes.Add(new Dictionary<string, object> { ["name"] = "doors", ["children"] = doorNodes });
        root = nodes.Count;
        nodes.Add(new Dictionary<string, object> { ["name"] = "world", ["rotation"] = new[] { -s, 0f, 0f, s }, ["children"] = new[] { ext, inter, doors } });

        var gltf = new Dictionary<string, object>
        {
            ["asset"] = new { version = "2.0", generator = "OceanExporter (CodeWalker.Core)" },
            ["scene"] = 0,
            ["scenes"] = new[] { new { nodes = new[] { root } } },
            ["nodes"] = nodes,
            ["meshes"] = meshes,
            ["materials"] = materials,
            ["accessors"] = accessors,
            ["bufferViews"] = bufferViews,
            ["buffers"] = new[] { new { uri = "scene.bin", byteLength = bin.Length } },
        };
        if (textures.Count > 0)
        {
            gltf["textures"] = textures;
            gltf["images"] = images;
            gltf["samplers"] = new[] { new { magFilter = 9729, minFilter = 9987, wrapS = 10497, wrapT = 10497 } };
        }
        File.WriteAllBytes(Path.Combine(outDir, "scene.bin"), bin.ToArray());
        File.WriteAllText(Path.Combine(outDir, "scene.gltf"), JsonSerializer.Serialize(gltf));

        WriteRooms(mlos, centre);
        Console.WriteLine($"gltf: nodes={nodes.Count} meshes={meshes.Count} materials={materials.Count} textures={textures.Count} bin={bin.Length / 1048576.0:F1}MB");
        Console.WriteLine($"textures missing={texMissing} decode-failed={texFailed}");
        if (missingTexNames.Count > 0) Console.WriteLine("missing textures: " + string.Join(", ", missingTexNames.Take(60)));
    }

    void WriteRooms(List<Program.MloInfo> mlos, Vector3 centre)
    {
        var outMlos = new List<object>();
        for (int m = 0; m < mlos.Count; m++)
        {
            var mi = mlos[m];
            var rooms = new List<object>();
            var rs = mi.Arch.rooms ?? Array.Empty<MCMloRoomDef>();
            for (int r = 0; r < rs.Length; r++)
            {
                var rd = rs[r];
                // transform the 8 corners of the local AABB into scene space (still Z-up)
                Vector3 mn = new(float.MaxValue), mx = new(float.MinValue);
                for (int c = 0; c < 8; c++)
                {
                    var lp = new Vector3((c & 1) == 0 ? rd.BBMin.X : rd.BBMax.X, (c & 2) == 0 ? rd.BBMin.Y : rd.BBMax.Y, (c & 4) == 0 ? rd.BBMin.Z : rd.BBMax.Z);
                    var wp = mi.Position + mi.Orientation.Multiply(lp) - centre;
                    mn = Vector3.Min(mn, wp); mx = Vector3.Max(mx, wp);
                }
                rooms.Add(new
                {
                    index = r, name = rd.RoomName, floorId = rd._Data.floorId,
                    min = new[] { mn.X, mn.Y, mn.Z }, max = new[] { mx.X, mx.Y, mx.Z },
                    objects = rd.AttachedObjects?.Length ?? 0
                });
            }
            var p = mi.Position - centre;
            outMlos.Add(new { name = mi.Name, position = new[] { p.X, p.Y, p.Z }, rooms });
        }
        File.WriteAllText(Path.Combine(outDir, "rooms.json"),
            JsonSerializer.Serialize(new { upAxis = "Z", worldCentre = new[] { centre.X, centre.Y, centre.Z }, mlos = outMlos }, new JsonSerializerOptions { WriteIndented = true }));
    }

    int GetMesh(DrawableBase d, string name)
    {
        if (meshIndex.TryGetValue(d, out var mi)) return mi;
        var models = d.DrawableModels?.High;
        var prims = new List<object>();
        meshExtent = 0;
        if (models != null)
            foreach (var model in models)
            {
                if (model?.Geometries == null) continue;
                foreach (var g in model.Geometries)
                {
                    var prim = BuildPrimitive(g);
                    if (prim != null) prims.Add(prim);
                }
            }
        int idx = -1;
        if (prims.Count > 0)
        {
            idx = meshes.Count;
            meshes.Add(new { name = name, primitives = prims });
            meshExtents.Add(meshExtent);
        }
        meshIndex[d] = idx;
        return idx;
    }

    static float Half(ushort h) => (float)BitConverter.UInt16BitsToHalf(h);

    static bool ReadComp(byte[] vb, int off, VertexComponentType t, float[] o)
    {
        switch (t)
        {
            case VertexComponentType.Float: o[0] = BitConverter.ToSingle(vb, off); return true;
            case VertexComponentType.Float2: o[0] = BitConverter.ToSingle(vb, off); o[1] = BitConverter.ToSingle(vb, off + 4); return true;
            case VertexComponentType.Float3:
            case VertexComponentType.Float4:
                o[0] = BitConverter.ToSingle(vb, off); o[1] = BitConverter.ToSingle(vb, off + 4); o[2] = BitConverter.ToSingle(vb, off + 8);
                if (t == VertexComponentType.Float4) o[3] = BitConverter.ToSingle(vb, off + 12);
                return true;
            case VertexComponentType.Half2: o[0] = Half(BitConverter.ToUInt16(vb, off)); o[1] = Half(BitConverter.ToUInt16(vb, off + 2)); return true;
            case VertexComponentType.Half4:
                for (int i = 0; i < 4; i++) o[i] = Half(BitConverter.ToUInt16(vb, off + i * 2));
                return true;
            case VertexComponentType.RGBA8SNorm:
                for (int i = 0; i < 4; i++) o[i] = Math.Max(-1f, (sbyte)vb[off + i] / 127f);
                return true;
            case VertexComponentType.Colour:
            case VertexComponentType.UByte4:
                for (int i = 0; i < 4; i++) o[i] = vb[off + i] / 255f;
                return true;
        }
        return false;
    }

    object BuildPrimitive(DrawableGeometry g)
    {
        var vd = g.VertexData;
        var ib = g.IndexBuffer?.Indices;
        if (vd?.VertexBytes == null || vd.Info == null || ib == null || ib.Length < 3) return null;
        var info = vd.Info;
        int n = vd.VertexCount, stride = vd.VertexStride;
        var vb = vd.VertexBytes;
        bool hasN = ((info.Flags >> 3) & 1) == 1, hasUV = ((info.Flags >> 6) & 1) == 1;
        if (((info.Flags) & 1) == 0) return null;
        int offP = info.GetComponentOffset(0), offN = info.GetComponentOffset(3), offT = info.GetComponentOffset(6);
        var tP = info.GetComponentType(0); var tN = info.GetComponentType(3); var tT = info.GetComponentType(6);

        var pos = new float[n * 3]; var nrm = hasN ? new float[n * 3] : null; var uv = hasUV ? new float[n * 2] : null;
        var tmp = new float[4];
        Vector3 mn = new(float.MaxValue), mx = new(float.MinValue);
        for (int i = 0; i < n; i++)
        {
            int b = i * stride;
            if (b + stride > vb.Length) return null;
            ReadComp(vb, b + offP, tP, tmp);
            pos[i * 3] = tmp[0]; pos[i * 3 + 1] = tmp[1]; pos[i * 3 + 2] = tmp[2];
            mn = Vector3.Min(mn, new Vector3(tmp[0], tmp[1], tmp[2])); mx = Vector3.Max(mx, new Vector3(tmp[0], tmp[1], tmp[2]));
            meshExtent = Math.Max(meshExtent, Math.Max(Math.Abs(tmp[0]), Math.Max(Math.Abs(tmp[1]), Math.Abs(tmp[2]))));
            if (hasN)
            {
                ReadComp(vb, b + offN, tN, tmp);
                var v = new Vector3(tmp[0], tmp[1], tmp[2]);
                float l = v.Length();
                v = l > 1e-6f ? v / l : Vector3.UnitZ;
                nrm[i * 3] = v.X; nrm[i * 3 + 1] = v.Y; nrm[i * 3 + 2] = v.Z;
            }
            if (hasUV)
            {
                ReadComp(vb, b + offT, tT, tmp);
                uv[i * 2] = tmp[0]; uv[i * 2 + 1] = tmp[1];
            }
        }
        // drop indices that reference out-of-range vertices
        var idx = new List<ushort>(ib.Length);
        for (int i = 0; i + 2 < ib.Length; i += 3)
            if (ib[i] < n && ib[i + 1] < n && ib[i + 2] < n) { idx.Add(ib[i]); idx.Add(ib[i + 1]); idx.Add(ib[i + 2]); }
        if (idx.Count == 0) return null;

        var attrs = new Dictionary<string, int>
        {
            ["POSITION"] = AddAccessor(pos, 5126, n, "VEC3", new[] { mn.X, mn.Y, mn.Z }, new[] { mx.X, mx.Y, mx.Z }, 34962)
        };
        if (hasN) attrs["NORMAL"] = AddAccessor(nrm, 5126, n, "VEC3", null, null, 34962);
        if (hasUV) attrs["TEXCOORD_0"] = AddAccessor(uv, 5126, n, "VEC2", null, null, 34962);
        int ia = AddAccessor(idx.ToArray(), 5123, idx.Count, "SCALAR", null, null, 34963);

        var prim = new Dictionary<string, object> { ["attributes"] = attrs, ["indices"] = ia, ["mode"] = 4 };
        int mat = GetMaterial(g.Shader, hasUV);
        if (mat >= 0) prim["material"] = mat;
        return prim;
    }

    int AddAccessor(Array data, int compType, int count, string type, float[] min, float[] max, int target)
    {
        while (bin.Length % 4 != 0) bin.WriteByte(0);
        long start = bin.Position;
        int byteLen = Buffer.ByteLength(data);
        var bytes = new byte[byteLen];
        Buffer.BlockCopy(data, 0, bytes, 0, byteLen);
        bin.Write(bytes, 0, byteLen);
        int bv = bufferViews.Count;
        bufferViews.Add(new { buffer = 0, byteOffset = start, byteLength = byteLen, target });
        var acc = new Dictionary<string, object> { ["bufferView"] = bv, ["componentType"] = compType, ["count"] = count, ["type"] = type };
        if (min != null) { acc["min"] = min; acc["max"] = max; }
        accessors.Add(acc);
        return accessors.Count - 1;
    }

    static string TexName(ShaderFX s, params string[] samplers)
    {
        var pl = s?.ParametersList;
        if (pl?.Parameters == null || pl.Hashes == null) return null;
        for (int i = 0; i < pl.Parameters.Length && i < pl.Hashes.Length; i++)
        {
            var p = pl.Parameters[i];
            if (p.DataType != 0 || p.Data is not TextureBase tb || tb.Name == null) continue;
            var pn = pl.Hashes[i].ToString();
            foreach (var sm in samplers) if (string.Equals(pn, sm, StringComparison.OrdinalIgnoreCase)) return tb.Name;
        }
        return null;
    }

    static string FirstTexName(ShaderFX s)
    {
        var pl = s?.ParametersList;
        if (pl?.Parameters == null) return null;
        foreach (var p in pl.Parameters) if (p.DataType == 0 && p.Data is TextureBase tb && tb.Name != null) return tb.Name;
        return null;
    }

    int GetMaterial(ShaderFX s, bool hasUV)
    {
        string shader = s?.Name.ToString() ?? "default";
        string sl = shader.ToLowerInvariant();
        string diff = hasUV ? (TexName(s, "DiffuseSampler", "TextureSampler", "DiffuseSampler2", "diffusetexture") ?? FirstTexName(s)) : null;
        string bump = hasUV ? TexName(s, "BumpSampler", "NormalSampler") : null;
        int bucket = s?.RenderBucket ?? 0;
        bool glass = sl.Contains("glass");
        bool emissive = sl.Contains("emissive");
        bool decal = sl.Contains("decal");
        bool cutout = sl.Contains("cutout") || bucket == 3;
        bool alpha = sl.Contains("alpha") || decal || glass || bucket == 1 || bucket == 2;
        string mode = cutout ? "MASK" : alpha ? "BLEND" : "OPAQUE";

        string key = $"{diff}|{bump}|{mode}|{emissive}|{glass}";
        if (materialIndex.TryGetValue(key, out var mi)) return mi;

        var pbr = new Dictionary<string, object> { ["metallicFactor"] = 0f, ["roughnessFactor"] = glass ? 0.05f : 0.8f };
        var mat = new Dictionary<string, object> { ["name"] = $"{shader}:{diff}", ["doubleSided"] = true, ["pbrMetallicRoughness"] = pbr };
        int dt = GetTexture(diff, false);
        if (dt >= 0) pbr["baseColorTexture"] = new { index = dt };
        else pbr["baseColorFactor"] = glass ? new[] { 0.7f, 0.85f, 0.9f, 0.25f } : new[] { 0.8f, 0.8f, 0.8f, 1f };
        if (glass && dt >= 0) pbr["baseColorFactor"] = new[] { 1f, 1f, 1f, 0.6f };
        int nt = GetTexture(bump, true);
        if (nt >= 0) mat["normalTexture"] = new { index = nt, scale = 1f };
        if (emissive && dt >= 0) { mat["emissiveTexture"] = new { index = dt }; mat["emissiveFactor"] = new[] { 1f, 1f, 1f }; }
        mat["alphaMode"] = mode;
        if (mode == "MASK") mat["alphaCutoff"] = 0.33f;
        mat["extras"] = new { shader, bucket };

        int idx = materials.Count;
        materials.Add(mat);
        materialIndex[key] = idx;
        return idx;
    }

    int GetTexture(string name, bool normal)
    {
        if (string.IsNullOrEmpty(name)) return -1;
        string key = (normal ? "n:" : "d:") + name;
        if (textureIndex.TryGetValue(key, out var ti)) return ti;
        int result = -1;
        var t = Program.FindTexture(name);
        if (t == null) { texMissing++; missingTexNames.Add(name); }
        else
        {
            try
            {
                int maxSize = normal ? 512 : 1024;
                int mip = 0;
                while (mip < t.Levels - 1 && (Math.Max(t.Width, t.Height) >> mip) > maxSize) mip++;
                var px = DDSIO.GetPixels(t, mip);
                int w = Math.Max(1, t.Width >> mip), h = Math.Max(1, t.Height >> mip);
                if (px == null || px.Length < w * h * 4) { texFailed++; }
                else
                {
                    var safe = new string(name.Select(c => char.IsLetterOrDigit(c) || c == '_' || c == '-' ? c : '_').ToArray()).ToLowerInvariant();
                    var file = $"textures/{safe}{(normal ? "_n" : "")}.png";
                    Png.Write(Path.Combine(outDir, file), px, w, h, normal);
                    images.Add(new { uri = file });
                    textures.Add(new { source = images.Count - 1, sampler = 0 });
                    result = textures.Count - 1;
                }
            }
            catch (Exception e) { texFailed++; Console.WriteLine($"  tex {name}: {e.Message}"); }
        }
        textureIndex[key] = result;
        return result;
    }
}

static class Png
{
    static readonly uint[] crcTable = Enumerable.Range(0, 256).Select(n =>
    {
        uint c = (uint)n;
        for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
        return c;
    }).ToArray();

    static uint Crc(byte[] type, byte[] data)
    {
        uint c = 0xFFFFFFFF;
        foreach (var b in type) c = crcTable[(c ^ b) & 0xFF] ^ (c >> 8);
        foreach (var b in data) c = crcTable[(c ^ b) & 0xFF] ^ (c >> 8);
        return c ^ 0xFFFFFFFF;
    }

    static void Chunk(Stream s, string type, byte[] data)
    {
        var t = Encoding.ASCII.GetBytes(type);
        void BE(uint v) { s.WriteByte((byte)(v >> 24)); s.WriteByte((byte)(v >> 16)); s.WriteByte((byte)(v >> 8)); s.WriteByte((byte)v); }
        BE((uint)data.Length); s.Write(t); s.Write(data); BE(Crc(t, data));
    }

    /// bgra: BGRA8 pixels. For normal maps the alpha is dropped and green is flipped (DirectX -> OpenGL convention).
    public static void Write(string path, byte[] bgra, int w, int h, bool normal)
    {
        bool hasAlpha = false;
        if (!normal) for (int i = 3; i < w * h * 4; i += 4) if (bgra[i] < 250) { hasAlpha = true; break; }
        int ch = hasAlpha ? 4 : 3;
        var raw = new byte[(w * ch + 1) * h];
        for (int y = 0; y < h; y++)
        {
            int ro = y * (w * ch + 1);
            raw[ro] = 0;
            for (int x = 0; x < w; x++)
            {
                int si = (y * w + x) * 4, di = ro + 1 + x * ch;
                raw[di] = bgra[si + 2];
                raw[di + 1] = normal ? (byte)(255 - bgra[si + 1]) : bgra[si + 1];
                raw[di + 2] = bgra[si];
                if (normal)
                {
                    // BC5/DXT5nm style maps may store only XY -> rebuild Z
                    float nx = raw[di] / 127.5f - 1f, ny = raw[di + 1] / 127.5f - 1f;
                    if (bgra[si] == 0 || bgra[si] == 255)
                        raw[di + 2] = (byte)Math.Clamp((Math.Sqrt(Math.Max(0, 1 - nx * nx - ny * ny)) * 0.5 + 0.5) * 255, 0, 255);
                }
                if (hasAlpha) raw[di + 3] = bgra[si + 3];
            }
        }
        using var fs = File.Create(path);
        fs.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 });
        var ihdr = new byte[13];
        ihdr[0] = (byte)(w >> 24); ihdr[1] = (byte)(w >> 16); ihdr[2] = (byte)(w >> 8); ihdr[3] = (byte)w;
        ihdr[4] = (byte)(h >> 24); ihdr[5] = (byte)(h >> 16); ihdr[6] = (byte)(h >> 8); ihdr[7] = (byte)h;
        ihdr[8] = 8; ihdr[9] = (byte)(hasAlpha ? 6 : 2);
        Chunk(fs, "IHDR", ihdr);
        using (var ms = new MemoryStream())
        {
            using (var z = new ZLibStream(ms, CompressionLevel.Optimal, true)) z.Write(raw);
            Chunk(fs, "IDAT", ms.ToArray());
        }
        Chunk(fs, "IEND", Array.Empty<byte>());
    }
}
