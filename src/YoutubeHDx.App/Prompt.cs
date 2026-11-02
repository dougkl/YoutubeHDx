namespace YoutubeHDx.App;

/// <summary>Minimal "type something" dialog (WinForms has no InputBox).</summary>
internal static class Prompt
{
    public static string? Ask(string title, string message)
    {
        using var form = new Form
        {
            Text = title, Width = 560, Height = 190, FormBorderStyle = FormBorderStyle.FixedDialog,
            StartPosition = FormStartPosition.CenterScreen, MinimizeBox = false, MaximizeBox = false, TopMost = true,
        };
        var label = new Label { Left = 12, Top = 12, Width = 520, Height = 40, Text = message };
        var box = new TextBox { Left = 12, Top = 60, Width = 520 };
        var ok = new Button { Text = "OK", Left = 372, Width = 75, Top = 100, DialogResult = DialogResult.OK };
        var cancel = new Button { Text = "Cancel", Left = 457, Width = 75, Top = 100, DialogResult = DialogResult.Cancel };
        form.Controls.AddRange([label, box, ok, cancel]);
        form.AcceptButton = ok;
        form.CancelButton = cancel;
        return form.ShowDialog() == DialogResult.OK ? box.Text.Trim() : null;
    }
}
