using YoutubeHDx.Core;

namespace YoutubeHDx.App;

/// <summary>Download list. Closing the window hides it; the app keeps running in the tray.</summary>
internal sealed class MainForm : Form
{
    private readonly DownloadQueue _queue;
    private readonly TextBox _url = new() { Dock = DockStyle.Fill, PlaceholderText = "Paste a YouTube video or playlist URL" };
    private readonly CheckBox _wholePlaylist = new() { Text = "Whole playlist", AutoSize = true, Anchor = AnchorStyles.Left };
    private readonly ListView _list = new()
    {
        Dock = DockStyle.Fill, View = View.Details, FullRowSelect = true, MultiSelect = false, HideSelection = false,
    };
    private readonly System.Windows.Forms.Timer _refresh = new() { Interval = 1000 };

    public MainForm(DownloadQueue queue)
    {
        _queue = queue;
        Text = "YoutubeHDx — 4K downloads";
        Width = 1500;
        Height = 480;
        StartPosition = FormStartPosition.CenterScreen;
        Icon = SystemIcons.Application;

        _list.Columns.Add("Title", 300);
        _list.Columns.Add("Playlist", 170);
        _list.Columns.Add("Status", 110);
        _list.Columns.Add("Progress", 70, HorizontalAlignment.Right);
        _list.Columns.Add("Speed", 85);
        _list.Columns.Add("ETA", 55);
        _list.Columns.Add("Saved", 50, HorizontalAlignment.Right);
        _list.Columns.Add("Last update", 120);
        _list.Columns.Add("Link", 260);
        _list.Columns.Add("Details", 240);
        // Double-click a row to open its YouTube link.
        _list.DoubleClick += (_, _) =>
        {
            if (_list.SelectedItems.Count == 1 && _list.SelectedItems[0].SubItems[8].Text is { Length: > 0 } url &&
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

        var cancel = new Button { Text = "Cancel selected", AutoSize = true };
        cancel.Click += (_, _) =>
        {
            if (_list.SelectedItems.Count == 1 && _list.SelectedItems[0].Tag is Guid id) _queue.Cancel(id);
        };
        var clear = new Button { Text = "Clear finished", AutoSize = true };
        clear.Click += (_, _) => { _queue.ClearFinished(); RefreshList(); };

        var bottom = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 40, Padding = new Padding(6) };
        bottom.Controls.Add(cancel);
        bottom.Controls.Add(clear);

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

    private void RefreshList()
    {
        var jobs = _queue.Snapshot().OrderByDescending(j => j.CreatedAt).ToList();
        var byId = _list.Items.Cast<ListViewItem>().ToDictionary(i => (Guid)i.Tag!);

        _list.BeginUpdate();
        foreach (var gone in byId.Keys.Except(jobs.Select(j => j.Id)).ToList())
            _list.Items.Remove(byId[gone]);

        for (var index = 0; index < jobs.Count; index++)
        {
            var j = jobs[index];
            var updated = (j.UpdatedAt ?? j.CreatedAt).ToLocalTime();
            var cells = new[]
            {
                j.Title ?? j.Url,
                j.PlaylistTitle ?? "",
                j.Status.ToString(),
                j.Status == JobStatus.Running ? $"{j.Percent:0.0}%" : "",
                j.Speed ?? "",
                j.Eta ?? "",
                j.ItemsCompleted.ToString(),
                updated.Date == DateTime.Today ? updated.ToString("HH:mm:ss") : updated.ToString("yyyy-MM-dd HH:mm"),
                j.Url,
                j.Error ?? j.LastFile ?? "",
            };

            if (!byId.TryGetValue(j.Id, out var item))
            {
                item = new ListViewItem(cells) { Tag = j.Id };
                _list.Items.Insert(Math.Min(index, _list.Items.Count), item);
            }
            else
            {
                for (var c = 0; c < cells.Length; c++)
                    if (item.SubItems[c].Text != cells[c]) item.SubItems[c].Text = cells[c];
            }

            item.ForeColor = j.Status switch
            {
                JobStatus.Failed => Color.Firebrick,
                JobStatus.CompletedWithErrors => Color.DarkOrange,
                JobStatus.Completed => Color.ForestGreen,
                JobStatus.Paused => Color.DarkGoldenrod,
                _ => SystemColors.WindowText,
            };
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
