using System.Diagnostics;
using YoutubeHDx.Core;
using YoutubeHDx.Core.Library;

namespace YoutubeHDx.App;

/// <summary>"Duplicates" and "Check these" tabs: what was hidden from Plex and why, and the pairs waiting for your answer.</summary>
internal sealed class DuplicatesPanel
{
    private readonly DuplicateFinder _finder;
    private readonly Func<CancellationToken> _stop;
    private readonly Control _owner;

    private readonly ListView _dups = MakeList();
    private readonly ListView _check = MakeList();
    private readonly Label _dupInfo = new() { Dock = DockStyle.Top, Height = 40, Padding = new Padding(6), ForeColor = SystemColors.GrayText };
    private readonly Label _checkInfo = new() { Dock = DockStyle.Top, Height = 40, Padding = new Padding(6), ForeColor = SystemColors.GrayText };
    private readonly Button _scan = new() { Text = "Check now", AutoSize = true };

    public TabPage DuplicatesTab { get; } = new("Duplicates");
    public TabPage CheckTab { get; } = new("Check these");

    public DuplicatesPanel(DuplicateFinder finder, Control owner, Func<CancellationToken> stop)
    {
        _finder = finder;
        _owner = owner;
        _stop = stop;

        foreach (var (name, width) in new[] { ("Hidden copy", 330), ("Folder", 170), ("State", 110), ("Quality", 110), ("Length", 55),
                     ("Size", 65), ("Kept copy (shown in Plex)", 330), ("Kept quality", 110), ("Why", 380) })
            _dups.Columns.Add(name, width);
        foreach (var (name, width) in new[] { ("File A", 330), ("Folder A", 150), ("A: quality, length", 150), ("File B", 330),
                     ("Folder B", 150), ("B: quality, length", 150), ("Why it's unsure", 330) })
            _check.Columns.Add(name, width);
        _dups.DoubleClick += (_, _) => { if (Selected(_dups).FirstOrDefault() is { } d) ShowInExplorer(d.Path); };
        _check.DoubleClick += (_, _) => { if (_check.SelectedItems.Count == 1 && _check.SelectedItems[0].Tag is CheckPair p) ShowInExplorer(p.PathA); };

        _scan.Click += async (_, _) => await Run(() => _finder.ScanAsync(_stop()), "Checking for duplicates…");
        var unignore = new Button { Text = "Un-ignore (show in Plex)", AutoSize = true };
        unignore.Click += async (_, _) => await Run(() => _finder.UnignoreAsync(Selected(_dups).Select(d => d.Path).ToList()));
        var reignore = new Button { Text = "Ignore again", AutoSize = true };
        reignore.Click += async (_, _) => await Run(() => _finder.IgnoreAgainAsync(Selected(_dups).Where(d => d.State == "shown").Select(d => d.Path).ToList()));
        var move = new Button { Text = "Move to…", AutoSize = true };
        move.Click += async (_, _) => await MoveSelected();
        var open = new Button { Text = "Open folder", AutoSize = true };
        open.Click += (_, _) => { if (Selected(_dups).FirstOrDefault() is { } d) ShowInExplorer(d.Path); };
        var pickUnsafe = new Button { Text = "Select the ones that can't be hidden", AutoSize = true };
        pickUnsafe.Click += (_, _) =>
        {
            foreach (ListViewItem i in _dups.Items) i.Selected = i.Tag is DuplicateEntry { State: "unsafe" };
            _dups.Focus();
        };
        var folders = new Button { Text = "Folders to check…", AutoSize = true };
        folders.Click += (_, _) => { using var f = new FoldersDialog(); if (f.ShowDialog(_owner) == DialogResult.OK) _ = Run(() => _finder.ScanAsync(_stop()), "Checking for duplicates…"); };

        var dupButtons = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 40, Padding = new Padding(6) };
        dupButtons.Controls.AddRange([_scan, unignore, reignore, move, pickUnsafe, open, folders]);
        DuplicatesTab.Controls.Add(_dups);
        DuplicatesTab.Controls.Add(_dupInfo);
        DuplicatesTab.Controls.Add(dupButtons);

        var same = new Button { Text = "Same song: hide the worse copy", AutoSize = true };
        same.Click += async (_, _) => await Decide(true);
        var different = new Button { Text = "Different songs: keep both", AutoSize = true };
        different.Click += async (_, _) => await Decide(false);
        var openBoth = new Button { Text = "Open both", AutoSize = true };
        openBoth.Click += (_, _) =>
        {
            if (_check.SelectedItems.Count == 1 && _check.SelectedItems[0].Tag is CheckPair p)
                foreach (var f in new[] { p.PathA, p.PathB }) Process.Start(new ProcessStartInfo(f) { UseShellExecute = true });
        };
        var checkButtons = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 40, Padding = new Padding(6) };
        checkButtons.Controls.AddRange([same, different, openBoth]);
        CheckTab.Controls.Add(_check);
        CheckTab.Controls.Add(_checkInfo);
        CheckTab.Controls.Add(checkButtons);

        _finder.Changed += r => { if (_owner.IsHandleCreated) _owner.BeginInvoke(() => Show(r)); };
        Show(_finder.Results);
    }

    private static ListView MakeList() => new()
    {
        Dock = DockStyle.Fill, View = View.Details, FullRowSelect = true, MultiSelect = true, HideSelection = false, ShowItemToolTips = true,
    };

    private IEnumerable<DuplicateEntry> Selected(ListView list) =>
        list.SelectedItems.Cast<ListViewItem>().Select(i => i.Tag).OfType<DuplicateEntry>().ToList();

    private string Rel(DuplicateResults r, string path)
    {
        var dir = Path.GetDirectoryName(path)!;
        var root = r.Folders.FirstOrDefault(f => dir.StartsWith(f, StringComparison.OrdinalIgnoreCase));
        return root is null ? dir : Path.GetRelativePath(root, dir) is "." ? "(top folder)" : Path.GetRelativePath(root, dir);
    }

    private void Show(DuplicateResults r)
    {
        var hidden = r.Duplicates.Count(d => d.State == "ignored");
        var shown = r.Duplicates.Count(d => d.State == "shown");
        var unsafeN = r.Duplicates.Count(d => d.State == "unsafe");
        DuplicatesTab.Text = $"Duplicates ({hidden})";
        CheckTab.Text = $"Check these ({r.Check.Count})";
        _dupInfo.Text = r.ScannedAt is null
            ? "Not checked yet. \"Check now\" looks through: " + string.Join(", ", DuplicateFinder.FoldersToCheck(SettingsStore.Load()))
            : $"Last check {r.ScannedAt.Value.ToLocalTime():MMM d HH:mm}: {r.FilesChecked} videos in {string.Join(", ", r.Folders)}. " +
              $"{hidden} copies hidden from Plex (via .plexignore, nothing deleted)" +
              (shown > 0 ? $", {shown} shown again by you" : "") +
              (unsafeN > 0 ? $", {unsafeN} can't be hidden by name (another file has the same name pattern): use Move to…" : "") + ".";
        _checkInfo.Text = r.Check.Count == 0
            ? "Nothing to check."
            : "These might be the same song, but the app isn't sure enough to hide one. Pick a line and answer; your answer is remembered.";

        Fill(_dups, r.Duplicates.Select(d => (object)d), o =>
        {
            var d = (DuplicateEntry)o;
            return new ListViewItem(new[]
            {
                Path.GetFileName(d.Path), Rel(r, d.Path),
                d.State switch { "ignored" => "Hidden", "shown" => "Shown (by you)", _ => "Can't hide by name" },
                d.Facts.Quality, d.Facts.Length, d.Facts.SizeText,
                Path.GetFileName(d.KeptPath), d.KeptFacts.Quality, d.Reason,
            })
            {
                Tag = d,
                ToolTipText = $"{d.Path}\nkept: {d.KeptPath}",
                ForeColor = d.State switch { "ignored" => SystemColors.WindowText, "shown" => SystemColors.GrayText, _ => Color.DarkOrange },
            };
        });
        Fill(_check, r.Check.Select(c => (object)c), o =>
        {
            var c = (CheckPair)o;
            return new ListViewItem(new[]
            {
                Path.GetFileName(c.PathA), Rel(r, c.PathA), $"{c.A.Quality}, {c.A.Length}",
                Path.GetFileName(c.PathB), Rel(r, c.PathB), $"{c.B.Quality}, {c.B.Length}", c.Reason,
            }) { Tag = c, ToolTipText = $"{c.PathA}\n{c.PathB}" };
        });
    }

    private static void Fill(ListView list, IEnumerable<object> rows, Func<object, ListViewItem> make)
    {
        var selected = list.SelectedItems.Cast<ListViewItem>().Select(i => i.ToolTipText).ToHashSet();
        list.BeginUpdate();
        list.Items.Clear();
        foreach (var row in rows)
        {
            var item = make(row);
            item.Selected = selected.Contains(item.ToolTipText);
            list.Items.Add(item);
        }
        list.EndUpdate();
    }

    private async Task Decide(bool sameSong)
    {
        if (_check.SelectedItems.Count != 1 || _check.SelectedItems[0].Tag is not CheckPair p) return;
        await Run(() => _finder.DecideAsync(p.PathA, p.PathB, sameSong, _stop()), sameSong ? "Hiding the worse copy…" : null);
    }

    private async Task MoveSelected()
    {
        var picked = Selected(_dups).Select(d => d.Path).ToList();
        if (picked.Count == 0) { MessageBox.Show(_owner, "Select the files to move first (Ctrl/Shift-click for several).", "YoutubeHDx"); return; }
        using var dialog = new FolderBrowserDialog
        {
            Description = $"Move {picked.Count} file(s), with their subtitles, to this folder (pick one outside the Plex library to keep them out of it):",
            UseDescriptionForTitle = true,
            ShowNewFolderButton = true,
        };
        if (dialog.ShowDialog(_owner) != DialogResult.OK) return;
        try
        {
            var result = await Task.Run(() => _finder.MoveAsync(picked, dialog.SelectedPath, _stop()));
            var text = $"Moved {result.Moved} of {picked.Count} file(s) to {dialog.SelectedPath}.";
            if (result.Problems.Count > 0) text += "\n\nNot moved:\n" + string.Join("\n", result.Problems.Take(15));
            MessageBox.Show(_owner, text, "YoutubeHDx", MessageBoxButtons.OK, result.Problems.Count > 0 ? MessageBoxIcon.Warning : MessageBoxIcon.Information);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            MessageBox.Show(_owner, ex.Message, "YoutubeHDx", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private async Task Run(Func<Task<DuplicateResults>> work, string? busy = null)
    {
        _scan.Enabled = false;
        if (busy is not null) _dupInfo.Text = busy + " (progress is on the Downloads tab, under \"Subtitles and Plex files\")";
        try { Show(await Task.Run(work)); }
        catch (OperationCanceledException) { }
        catch (Exception ex) { MessageBox.Show(_owner, ex.Message, "YoutubeHDx", MessageBoxButtons.OK, MessageBoxIcon.Error); }
        finally { _scan.Enabled = true; }
    }

    private static void ShowInExplorer(string path)
    {
        try { Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"") { UseShellExecute = true }); }
        catch (Exception ex) { FileLog.Write($"Could not open Explorer: {ex.Message}"); }
    }
}

/// <summary>Which folders the duplicate check looks through, and which subfolders it skips.</summary>
internal sealed class FoldersDialog : Form
{
    private readonly ListBox _folders = new() { Dock = DockStyle.Fill, IntegralHeight = false };
    private readonly TextBox _skip = new() { Dock = DockStyle.Fill };

    public FoldersDialog()
    {
        Text = "Folders to check for duplicates";
        Width = 720;
        Height = 380;
        StartPosition = FormStartPosition.CenterParent;
        var s = SettingsStore.Load();
        foreach (var f in DuplicateFinder.FoldersToCheck(s)) _folders.Items.Add(f);
        _skip.Text = string.Join(", ", s.DuplicateSkipFolders);

        var add = new Button { Text = "Add folder…", AutoSize = true };
        add.Click += (_, _) =>
        {
            using var d = new FolderBrowserDialog { Description = "Folder with music videos (all its subfolders are checked too)", UseDescriptionForTitle = true };
            if (d.ShowDialog(this) == DialogResult.OK && !_folders.Items.Contains(d.SelectedPath)) _folders.Items.Add(d.SelectedPath);
        };
        var remove = new Button { Text = "Remove", AutoSize = true };
        remove.Click += (_, _) => { if (_folders.SelectedItem is { } x) _folders.Items.Remove(x); };
        var ok = new Button { Text = "Save and check", AutoSize = true, DialogResult = DialogResult.OK };
        ok.Click += (_, _) =>
        {
            var settings = SettingsStore.Load();
            settings.DuplicateFolders = _folders.Items.Cast<string>().ToList();
            settings.DuplicateSkipFolders = _skip.Text.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
            SettingsStore.Save(settings);
        };
        var cancel = new Button { Text = "Cancel", AutoSize = true, DialogResult = DialogResult.Cancel };

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 5, Padding = new Padding(8) };
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.Controls.Add(new Label { AutoSize = true, Text = "Folders (with all their subfolders) where the same song may be saved more than once:" });
        layout.Controls.Add(_folders);
        var row = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill };
        row.Controls.AddRange([add, remove]);
        layout.Controls.Add(row);
        var skipRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, AutoSize = true };
        skipRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        skipRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        skipRow.Controls.Add(new Label { AutoSize = true, Text = "Skip subfolders named:", Padding = new Padding(0, 6, 0, 0) });
        skipRow.Controls.Add(_skip);
        layout.Controls.Add(skipRow);
        var buttons = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft };
        buttons.Controls.AddRange([cancel, ok]);
        layout.Controls.Add(buttons);
        Controls.Add(layout);
        AcceptButton = ok;
        CancelButton = cancel;
    }
}
