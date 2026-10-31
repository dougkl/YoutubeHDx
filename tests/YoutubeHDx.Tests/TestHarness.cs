using System.Reflection;
using System.Runtime.CompilerServices;

namespace YoutubeHDx.Tests;

[AttributeUsage(AttributeTargets.Method)]
internal sealed class TestAttribute : Attribute { }

internal sealed class AssertException(string message) : Exception(message);

internal static class Assert
{
    public static void True(bool condition, string? message = null, [CallerArgumentExpression(nameof(condition))] string? expr = null)
    {
        if (!condition) throw new AssertException(message ?? $"Expected true: {expr}");
    }

    public static void False(bool condition, [CallerArgumentExpression(nameof(condition))] string? expr = null)
    {
        if (condition) throw new AssertException($"Expected false: {expr}");
    }

    public static void Equal<T>(T expected, T actual, [CallerArgumentExpression(nameof(actual))] string? expr = null)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
            throw new AssertException($"{expr}: expected <{expected}>, got <{actual}>");
    }

    public static void Contains(string needle, string haystack)
    {
        if (!haystack.Contains(needle, StringComparison.Ordinal))
            throw new AssertException($"Expected to find \"{needle}\" in:\n{haystack}");
    }

    public static void Contains<T>(T item, IEnumerable<T> items, [CallerArgumentExpression(nameof(items))] string? expr = null)
    {
        if (!items.Contains(item)) throw new AssertException($"{expr} does not contain <{item}>");
    }

    public static void DoesNotContain<T>(T item, IEnumerable<T> items, [CallerArgumentExpression(nameof(items))] string? expr = null)
    {
        if (items.Contains(item)) throw new AssertException($"{expr} unexpectedly contains <{item}>");
    }

    public static TEx Throws<TEx>(Action action) where TEx : Exception
    {
        try { action(); }
        catch (TEx ex) { return ex; }
        catch (Exception ex) { throw new AssertException($"Expected {typeof(TEx).Name}, got {ex.GetType().Name}: {ex.Message}"); }
        throw new AssertException($"Expected {typeof(TEx).Name}, nothing was thrown");
    }
}

internal static class Runner
{
    public static async Task<int> RunAllAsync(string? filter)
    {
        var tests = typeof(Runner).Assembly.GetTypes()
            .SelectMany(t => t.GetMethods(BindingFlags.Public | BindingFlags.Static))
            .Where(m => m.GetCustomAttribute<TestAttribute>() is not null)
            .Where(m => filter is null || $"{m.DeclaringType!.Name}.{m.Name}".Contains(filter, StringComparison.OrdinalIgnoreCase))
            .OrderBy(m => m.DeclaringType!.Name).ThenBy(m => m.MetadataToken)
            .ToList();

        var failed = 0;
        foreach (var m in tests)
        {
            var name = $"{m.DeclaringType!.Name}.{m.Name}";
            try
            {
                TestEnv.ResetAppState();
                var result = m.Invoke(null, null);
                if (result is Task task) await task.WaitAsync(TimeSpan.FromSeconds(30));
                Console.WriteLine($"  PASS  {name}");
            }
            catch (Exception ex)
            {
                failed++;
                var inner = ex is TargetInvocationException { InnerException: { } ie } ? ie : ex;
                Console.WriteLine($"  FAIL  {name}\n        {inner.GetType().Name}: {inner.Message.Replace("\n", "\n        ")}");
            }
        }

        Console.WriteLine($"\n{tests.Count - failed} passed, {failed} failed, {tests.Count} total");
        return failed;
    }
}
