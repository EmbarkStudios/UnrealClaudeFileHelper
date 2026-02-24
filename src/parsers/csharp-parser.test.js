import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSharpContent } from './csharp-parser.js';

describe('parseCSharpContent', () => {
  it('parses Build.cs class with constructor and method calls', () => {
    const content = `
using UnrealBuildTool;

public class MyGame : ModuleRules
{
    public MyGame(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        PublicDependencyModuleNames.AddRange(new string[] {
            "Core",
            "CoreUObject",
            "Engine"
        });
    }
}`;
    const result = parseCSharpContent(content, 'MyGame.Build.cs');
    assert.equal(result.classes.length, 1);
    assert.equal(result.classes[0].name, 'MyGame');
    assert.equal(result.classes[0].parent, 'ModuleRules');
    assert.equal(result.classes[0].kind, 'class');

    const ctor = result.members.find(m => m.name === 'MyGame' && m.memberKind === 'function');
    assert.ok(ctor, 'constructor should be parsed');
    assert.equal(ctor.ownerName, 'MyGame');
  });

  it('parses Target.cs class with properties', () => {
    const content = `
using UnrealBuildTool;

public class MyGameTarget : TargetRules
{
    public MyGameTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Game;
        DefaultBuildSettings = BuildSettingsVersion.Latest;
    }
}`;
    const result = parseCSharpContent(content, 'MyGame.Target.cs');
    assert.equal(result.classes.length, 1);
    assert.equal(result.classes[0].name, 'MyGameTarget');
    assert.equal(result.classes[0].parent, 'TargetRules');
  });

  it('parses enum with values', () => {
    const content = `
public enum BuildType
{
    Debug,
    Development,
    Shipping
}`;
    const result = parseCSharpContent(content, 'test.cs');
    assert.equal(result.enums.length, 1);
    assert.equal(result.enums[0].name, 'BuildType');

    const values = result.members.filter(m => m.memberKind === 'enum_value');
    assert.equal(values.length, 3);
    assert.deepEqual(values.map(v => v.name), ['Debug', 'Development', 'Shipping']);
    assert.equal(values[0].ownerName, 'BuildType');
  });

  it('parses interface', () => {
    const content = `
public interface IBuildModule
{
    void Configure(TargetRules Target);
    string Name { get; }
}`;
    const result = parseCSharpContent(content, 'test.cs');
    assert.equal(result.classes.length, 1);
    assert.equal(result.classes[0].name, 'IBuildModule');
    assert.equal(result.classes[0].kind, 'interface');

    const method = result.members.find(m => m.name === 'Configure');
    assert.ok(method, 'interface method should be parsed');
    assert.equal(method.memberKind, 'function');
  });

  it('parses attributes as specifiers', () => {
    const content = `
[Serializable]
public class MyConfig
{
    [Required]
    public string Name { get; set; }
}`;
    const result = parseCSharpContent(content, 'test.cs');
    assert.equal(result.classes.length, 1);
    assert.deepEqual(result.classes[0].specifiers, ['Serializable']);
  });

  it('handles block namespace', () => {
    const content = `
namespace UnrealBuildTool
{
    public class MyModule : ModuleRules
    {
        public MyModule(ReadOnlyTargetRules Target) : base(Target)
        {
        }
    }
}`;
    const result = parseCSharpContent(content, 'test.cs');
    assert.equal(result.classes.length, 1);
    assert.equal(result.classes[0].name, 'MyModule');
    assert.equal(result.classes[0].parent, 'ModuleRules');
  });

  it('handles file-scoped namespace', () => {
    const content = `
namespace UnrealBuildTool;

public class MyModule : ModuleRules
{
    public MyModule(ReadOnlyTargetRules Target) : base(Target)
    {
    }
}`;
    const result = parseCSharpContent(content, 'test.cs');
    assert.equal(result.classes.length, 1);
    assert.equal(result.classes[0].name, 'MyModule');
  });

  it('parses auto-properties, static methods, expression-bodied members', () => {
    const content = `
public class Config
{
    public string Name { get; set; }
    public int Count { get; private set; }
    public static Config Default => new Config();
    public static Config Create(string name)
    {
        return new Config();
    }
}`;
    const result = parseCSharpContent(content, 'test.cs');
    assert.equal(result.classes.length, 1);

    const name = result.members.find(m => m.name === 'Name');
    assert.ok(name, 'auto-property Name should be parsed');
    assert.equal(name.memberKind, 'property');

    const count = result.members.find(m => m.name === 'Count');
    assert.ok(count, 'auto-property Count should be parsed');

    const def = result.members.find(m => m.name === 'Default');
    assert.ok(def, 'expression-bodied Default should be parsed');

    const create = result.members.find(m => m.name === 'Create');
    assert.ok(create, 'static method Create should be parsed');
    assert.equal(create.isStatic, true);
  });

  it('strips generic type params from class name', () => {
    const content = `
public class Repository<T> : IRepository<T>
{
    public T Get(int id) { return default; }
}`;
    const result = parseCSharpContent(content, 'test.cs');
    assert.equal(result.classes.length, 1);
    assert.equal(result.classes[0].name, 'Repository');
  });

  it('handles empty input', () => {
    const result = parseCSharpContent('', 'empty.cs');
    assert.equal(result.classes.length, 0);
    assert.equal(result.structs.length, 0);
    assert.equal(result.enums.length, 0);
    assert.equal(result.members.length, 0);
    assert.equal(result.path, 'empty.cs');
  });

  it('handles invalid/random input', () => {
    const result = parseCSharpContent('this is not valid C# code\n!!!', 'bad.cs');
    assert.equal(result.classes.length, 0);
    assert.equal(result.path, 'bad.cs');
  });

  it('parses struct', () => {
    const content = `
public struct BuildSettings
{
    public string Platform;
    public bool Debug;
}`;
    const result = parseCSharpContent(content, 'test.cs');
    assert.equal(result.structs.length, 1);
    assert.equal(result.structs[0].name, 'BuildSettings');

    const fields = result.members.filter(m => m.ownerName === 'BuildSettings');
    assert.equal(fields.length, 2);
  });

  it('parses delegate', () => {
    const content = `
public delegate void BuildCompleted(bool success);

public class Builder
{
    public BuildCompleted OnCompleted;
}`;
    const result = parseCSharpContent(content, 'test.cs');
    assert.equal(result.delegates.length, 1);
    assert.equal(result.delegates[0].name, 'BuildCompleted');
  });

  it('handles interpolated strings with braces correctly', () => {
    const content = `
public class InterpolatedTest
{
    public string GetMsg(string name) => $"Hello {name}!";
    public int Count;
}`;
    const result = parseCSharpContent(content, 'test.cs');
    assert.equal(result.classes.length, 1);
    const count = result.members.find(m => m.name === 'Count');
    assert.ok(count, 'Count field should be parsed after interpolated string member');
  });

  it('handles inline block comments with braces correctly', () => {
    const content = `
public class BlockCommentTest
{
    int x = 1; /* { extra brace */
    public int Count;
}`;
    const result = parseCSharpContent(content, 'test.cs');
    assert.equal(result.classes.length, 1);
    const count = result.members.find(m => m.name === 'Count');
    assert.ok(count, 'Count field should be parsed despite block comment braces');
  });

  it('handles verbatim strings with braces correctly', () => {
    const content = `
public class VerbatimTest
{
    public string Path = @"C:\\Users\\test\\{folder}";
    public string Escaped = @"He said ""hello""";
    public int Count;
}`;
    const result = parseCSharpContent(content, 'test.cs');
    assert.equal(result.classes.length, 1);
    // Should not be confused by braces inside verbatim strings
    const count = result.members.find(m => m.name === 'Count');
    assert.ok(count, 'Count field should be parsed despite verbatim string braces');
  });

  it('parses class with multiple inheritance (interfaces)', () => {
    const content = `
public class MyModule : ModuleRules, IDisposable, ICloneable
{
    public void Dispose() { }
    public object Clone() { return null; }
}`;
    const result = parseCSharpContent(content, 'test.cs');
    assert.equal(result.classes.length, 1);
    assert.equal(result.classes[0].name, 'MyModule');
    assert.equal(result.classes[0].parent, 'ModuleRules');
  });
});
