using System.Text;
using System;
using System.IO;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Linq;
using Underanalyzer.Decompiler;

EnsureDataLoaded();

string codeFolder = Path.Combine(Path.GetDirectoryName(FilePath), "Export_Code");
Directory.CreateDirectory(codeFolder);

GlobalDecompileContext globalDecompileContext = new(Data);
// Cast for setters
DecompileSettings decompilerSettings = new();
decompilerSettings.RemoveSingleLineBlockBraces = true;
decompilerSettings.OpenBlockBraceOnSameLine = false;
decompilerSettings.EmptyLineAroundBranchStatements = false;

List<UndertaleCode> toDump = Data.Code.Where(c => c.ParentEntry is null).ToList();

DumpAssetNames();

await DumpCode();

ScriptMessage($"Export Complete.\n\nDumped {toDump.Count}/{Data.Code.Count} entries.\nLocation: {codeFolder}");

async Task DumpCode()
{
    await Task.Run(() => Parallel.ForEach(toDump, DumpCode));
}

void DumpAssetNames()
{
    StringBuilder json = new();
    json.Append("{");

    void Append(string key, IEnumerable<UndertaleNamedResource> assets, bool last)
    {
        json.Append("\"" + key + "\":[");
        bool first = true;
        foreach (UndertaleNamedResource asset in assets ?? Enumerable.Empty<UndertaleNamedResource>())
        {
            if (!first)
                json.Append(",");
            string name = asset?.Name?.Content ?? "";
            json.Append("\"" + name.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"");
            first = false;
        }
        json.Append(last ? "]" : "],");
    }

    Append("sprites", Data.Sprites, false);
    Append("objects", Data.GameObjects, false);
    Append("rooms", Data.Rooms, false);
    Append("sounds", Data.Sounds, false);
    Append("fonts", Data.Fonts, true);

    json.Append("}");
    File.WriteAllText(Path.Combine(codeFolder, "assets.json"), json.ToString());
}

void DumpCode(UndertaleCode code)
{
    if (code is not null)
    {
        string path = Path.Combine(codeFolder, code.Name.Content + ".gml");
        try
        {
            File.WriteAllText(
                path,
                new DecompileContext(globalDecompileContext, code, decompilerSettings).DecompileToString());
        }
        catch (Exception e)
        {
            File.WriteAllText(path, "/*\nDECOMPILER FAILED!\n\n" + e.ToString() + "\n*/");
        }
    }
}
