using YoutubeHDx.Core;

namespace YoutubeHDx.App;

/// <summary>
/// Download list: one line per playlist or video (a new sync replaces the line of the previous one), plus the
/// background tasks (subtitle check, Plex info files). Closing the window hides it; the app keeps running in the tray.
/// </summary>
internal sealed class MainForm : Form
{
    private const int LinkColumn = 9;

    private readonly DownloadQueue _queue;
    private readonly ActivityBoard _board;
    private readonly TextBox _url = new() { Dock = DockStyle.Fill, PlaceholderText = "Paste a YouTube video or playlist URL" };
    private readonly CheckBox _wholePlaylist = new() { Text = "Whole playlist", AutoSize = true, Anchor = AnchorStyles.Left };
    private readonly ListView _list = new()
    {
        Dock = DockStyle.Fill, View = View.Details, FullRowSelect = true, MultiSelect = false, HideSelection = false,
        ShowItemToolTips = true, ShowGroups = true,
    };
    private readonly ListViewGroup _downloads = new("downloads", "Downloads");
    private readonly ListViewGroup _background = new("background", "Subtitles and Plex files");
    private readonly System.Windows.Forms.Timer _refresh = new() { Interval = 1000 };

    public MainForm(DownloadQueue queue, ActivityBoard board)
    {
        _queue = queue;
        _board = board;
        Text = "YoutubeHDx — 4K downloads";
        Width = 1550;
        Height = 520;
        StartPosition = FormStartPosition.CenterScreen;
        Icon = SystemIcons.Application;

        _list.Groups.Add(_downloads);
        _list.Groups.Add(_background);
        _list.Columns.Add("Name", 260);
        _list.Columns.Add("Status", 160);
        _list.Columns.Add("Progress", 70, HorizontalAlignment.Right);
        _list.Columns.Add("Speed", 80);
        _list.Columns.Add("ETA", 55);
        _list.Columns.Add("New", 45, HorizontalAlignment.Right);
        _list.Columns.Add("Subtitles", 150);
        _list.Columns.Add("Last update", 110);
        _list.Columns.Add("Details", 420);
        _list.Columns.Add("Link", 230);
        // Double-click a row to open its YouTube link.
        _list.DoubleClick += (_, _) =>
        {
            if (_list.SelectedItems.Count == 1 && _list.SelectedItems[0].SubItems[LinkColumn].Text is { Length: > 0 } url &&
                Uri.TryCreate(url, UriKind.Absolute, out var u) && u.Scheme is "https" or "http")
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true });
        };

        var add = new Button { Text = "Download 4K", AutoSize = true };
        add.Click += (_, _) => AddUrl();
        _url.KeyDown += (_, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; AddUrl(); } };

        var top = new TableLayoutPanel { Dock = DockStyle.Top, Height = 38, ColumnCount = 3, Padding = new Padding(6) };
        top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        top.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        top.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        top.Controls.Add(_url, 0, 0);
        top.Controls.Add(_wholePlaylist, 1, 0);
        top.Controls.Add(add, 2, 0);

        var cancel = new Button { Text = "Stop selected", AutoSize = true };
        cancel.Click += (_, _) =>
        {
            if (_list.SelectedItems.Count == 1 && _list.SelectedItems[0].Tag is Guid id) _queue.Cancel(id);
        };
        var clear = new Button { Text = "Clear finished", AutoSize = true };
        clear.Click += (_, _) => { _queue.ClearFinished(); RefreshList(); };
        var hint = new Label
        {
            AutoSize = true, Padding = new Padding(8, 8, 0, 0), ForeColor = SystemColors.GrayText,
            Text = "Hover a line for the full message · double-click to open it on YouTube",
        };

        var bottom = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 40, Padding = new Padding(6) };
        bottom.Controls.Add(cancel);
        bottom.Controls.Add(clear);
        bottom.Controls.Add(hint);

        Controls.Add(_list);
        Controls.Add(top);
        Controls.Add(bottom);

        _refresh.Tick += (_, _) => RefreshList();
        _refresh.Start();
        RefreshList();
    }

    private void AddUrl()
    {
        var url = _url.Text.Trim();
        if (url.Length == 0) return;
        try
        {
            var (added, _) = _queue.Enqueue(url, noPlaylist: !_wholePlaylist.Checked, source: "manual");
            if (!added) MessageBox.Show(this, "That URL is already queued.", "YoutubeHDx");
            _url.Clear();
            RefreshList();
        }
        catch (ArgumentException ex)
        {
            MessageBox.Show(this, ex.Message, "YoutubeHDx", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private static string When(DateTimeOffset at)
    {
        var t = at.ToLocalTime();
        return t.Date == DateTime.Today ? t.ToString("HH:mm:ss") : t.ToString("MMM d HH:mm");
    }

    private void RefreshList()
    {
        // Active first (running, then waiting), then finished, newest first.
        var jobs = _queue.Snapshot()
            .OrderBy(j => j.Status switch { JobStatus.Running => 0, JobStatus.Paused => 1, JobStatus.Queued => 2, _ => 3 })
            .ThenByDescending(j => j.UpdatedAt ?? j.CreatedAt)
            .ToList();
        var activities = _board.Snapshot();

        var rows = new List<(object Key, ListViewGroup Group, string[] Cells, Color Color, string Tip)>();
        foreach (var j in jobs)
        {
            var running = j.Status == JobStatus.Running && j.Title is not null;
            rows.Add((j.Id, _downloads, new[]
            {
                j.Name ?? j.Title ?? j.Url,
                j.StatusText ?? j.Status.ToString(),
                running ? $"{j.Percent:0}%" : "",
                running ? j.Speed ?? "" : "",
                running ? j.Eta ?? "" : "",
                j.ItemsCompleted > 0 ? j.ItemsCompleted.ToString() : "",
                j.Subtitles ?? "",
                When(j.UpdatedAt ?? j.CreatedAt),
                j.Summary ?? "",
                j.Url,
            }, j.Status switch
            {
                JobStatus.Failed => Color.Firebrick,
                JobStatus.CompletedWithErrors => Color.DarkOrange,
                JobStatus.Completed => Color.ForestGreen,
                JobStatus.Paused => Color.DarkGoldenrod,
                JobStatus.Running => Color.RoyalBlue,
                _ => SystemColors.WindowText,
            }, string.Join("\n", new[] { j.Summary, j.Error is { } e && e != j.Summary ? "yt-dlp: " + e : null, j.LastFile is { } f ? "Last saved: " + f : null }
                .Where(x => !string.IsNullOrEmpty(x)))));
        }
        foreach (var a in activities)
        {
            rows.Add(("activity:" + a.Key, _background, new[]
            {
                a.Name,
                a.StatusText,
                a.Running && a.Total > 0 ? $"{a.Percent:0}%" : "",
                "", "", "", "",
                When(a.UpdatedAt),
                a.Running ? (a.Current ?? "") : (a.Summary ?? ""),
                "",
            }, a.Running ? Color.RoyalBlue : SystemColors.GrayText, a.Running ? $"{a.Current}\n{a.Summary}" : a.Summary ?? ""));
        }

        var existing = _list.Items.Cast<ListViewItem>().ToDictionary(i => i.Tag!);
        _list.BeginUpdate();
        foreach (var gone in existing.Keys.Except(rows.Select(r => r.Key)).ToList())
            _list.Items.Remove(existing[gone]);

        for (var index = 0; index < rows.Count; index++)
        {
            var (key, group, cells, color, tip) = rows[index];
            if (!existing.TryGetValue(key, out var item))
            {
                item = new ListViewItem(cells) { Tag = key, Group = group };
                _list.Items.Insert(Math.Min(index, _list.Items.Count), item);
            }
            else
            {
                for (var c = 0; c < cells.Length; c++)
                    if (item.SubItems[c].Text != cells[c]) item.SubItems[c].Text = cells[c];
                if (_list.Items.IndexOf(item) != index && index < _list.Items.Count)
                {
                    var selected = item.Selected;
                    _list.Items.Remove(item);
                    _list.Items.Insert(index, item);
                    item.Group = group;
                    item.Selected = selected;
                }
            }
            item.ForeColor = color;
            item.ToolTipText = tip;
        }
        _list.EndUpdate();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            return;
        }
        _refresh.Stop();
        base.OnFormClosing(e);
    }
}
