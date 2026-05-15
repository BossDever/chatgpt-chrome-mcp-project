param(
  [ValidateSet("read", "send", "downloads", "download", "attachments", "upload", "removeattachments", "state", "codeblocks", "lastresponse", "stop")]
  [string]$Action = "read",

  [string]$WindowTitleContains = "",
  [string]$Message = "",
  [string]$EncodedMessage = "",
  [string]$FilePath = "",
  [string]$EncodedFilePath = "",
  [int]$MaxItems = 80,
  [string]$DownloadNameContains = "",
  [string]$AttachmentNameContains = "",
  [string]$DownloadDirectory = "",
  [int]$WaitForDownloadSeconds = 30,
  [int]$WaitForUploadSeconds = 30,
  [int]$MaxDownloads = 1,
  [int]$MaxAttachments = 10,
  [int]$MaxCodeBlocks = 5,
  [int]$CodeBlockOffsetFromLatest = 0,
  [switch]$NoSubmit,
  [switch]$AllowMismatch
)

$ErrorActionPreference = "Stop"

if ($EncodedMessage) {
  $Message = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($EncodedMessage))
}

if ($EncodedFilePath) {
  $FilePath = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($EncodedFilePath))
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName WindowsBase

$source = @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

public static class ChatGptUiaBridge
{
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;

    public static string ReadJson(string titleContains, int maxItems)
    {
        var hwnd = FindChromeWindow(titleContains);
        var root = AutomationElement.FromHandle(hwnd);
        if (root == null) throw new Exception("Chrome window was found, but UI Automation could not attach to it.");

        var prompt = FindVisibleByAutomationId(root, "prompt-textarea");
        var promptTop = prompt == null
            ? Double.PositiveInfinity
            : prompt.Current.BoundingRectangle.Top;

        var main = FindByAutomationId(root, "main")
            ?? FindByAutomationId(root, "RootWebArea")
            ?? root;

        var items = ReadVisibleTextItems(main, promptTop);
        var downloadButtons = FindDownloadButtons(main, promptTop);
        var joined = string.Join("\n", items.Select(i => i.Name));
        var promptValue = ReadValue(prompt);

        int start = Math.Max(0, items.Count - Math.Max(1, maxItems));
        var sb = new StringBuilder();
        sb.Append("{");
        sb.Append("\"ok\":true,");
        sb.Append("\"windowTitle\":").Append(Json(root.Current.Name)).Append(",");
        sb.Append("\"hash\":").Append(Json(Sha256(joined))).Append(",");
        sb.Append("\"totalItems\":").Append(items.Count).Append(",");
        sb.Append("\"promptValue\":").Append(Json(promptValue)).Append(",");
        sb.Append("\"items\":[");
        for (int i = start; i < items.Count; i++)
        {
            if (i > start) sb.Append(",");
            sb.Append("{");
            sb.Append("\"index\":").Append(items[i].Index).Append(",");
            sb.Append("\"controlType\":").Append(Json(items[i].ControlType)).Append(",");
            sb.Append("\"text\":").Append(Json(items[i].Name));
            sb.Append("}");
        }
        sb.Append("],");
        sb.Append("\"downloadButtons\":").Append(DownloadButtonsJson(downloadButtons)).Append(",");
        sb.Append("\"tailText\":").Append(Json(string.Join("\n", items.Skip(start).Select(i => i.Name))));
        sb.Append("}");
        return sb.ToString();
    }

    public static string DownloadsJson(string titleContains)
    {
        var hwnd = FindChromeWindow(titleContains);
        var root = AutomationElement.FromHandle(hwnd);
        if (root == null) throw new Exception("Chrome window was found, but UI Automation could not attach to it.");

        var prompt = FindVisibleByAutomationId(root, "prompt-textarea");
        var promptTop = prompt == null
            ? Double.PositiveInfinity
            : prompt.Current.BoundingRectangle.Top;
        var document = FindByAutomationId(root, "RootWebArea") ?? root;
        var downloadButtons = FindDownloadButtons(document, promptTop);

        var sb = new StringBuilder();
        sb.Append("{");
        sb.Append("\"ok\":true,");
        sb.Append("\"windowTitle\":").Append(Json(root.Current.Name)).Append(",");
        sb.Append("\"downloadButtons\":").Append(DownloadButtonsJson(downloadButtons));
        sb.Append("}");
        return sb.ToString();
    }

    public static string AttachmentsJson(string titleContains)
    {
        var hwnd = FindChromeWindow(titleContains);
        var root = AutomationElement.FromHandle(hwnd);
        if (root == null) throw new Exception("Chrome window was found, but UI Automation could not attach to it.");

        var attachments = FindAttachments(root);

        var sb = new StringBuilder();
        sb.Append("{");
        sb.Append("\"ok\":true,");
        sb.Append("\"windowTitle\":").Append(Json(root.Current.Name)).Append(",");
        sb.Append("\"attachmentCount\":").Append(attachments.Count).Append(",");
        sb.Append("\"attachments\":").Append(AttachmentsJsonArray(attachments));
        sb.Append("}");
        return sb.ToString();
    }

    public static string UploadFileJson(string titleContains, string filePath, int waitSeconds)
    {
        if (String.IsNullOrWhiteSpace(filePath)) throw new Exception("FilePath is empty.");

        var fullPath = Path.GetFullPath(filePath);
        if (!File.Exists(fullPath)) throw new Exception("Upload file does not exist: " + fullPath);

        var hwnd = FindChromeWindow(titleContains);
        SetForegroundWindow(hwnd);
        Thread.Sleep(250);

        var root = AutomationElement.FromHandle(hwnd);
        if (root == null) throw new Exception("Chrome window was found, but UI Automation could not attach to it.");

        var before = FindAttachments(root);
        AutomationElement fileNameEdit = null;
        AutomationElement openButton = null;
        string uploadItemName = "";

        WaitForFileDialog(root, 1, out fileNameEdit, out openButton);
        if (fileNameEdit == null || openButton == null)
        {
            var uploadItem = FindUploadMenuItem(root);
            if (uploadItem == null)
            {
                var plus = FindByAutomationId(root, "composer-plus-btn");
                if (plus == null) throw new Exception("Could not find ChatGPT composer-plus-btn.");
                ClickElementWithMouse(plus);
                Thread.Sleep(700);
                root = AutomationElement.FromHandle(hwnd);
                uploadItem = FindUploadMenuItem(root);
            }
            if (uploadItem == null) throw new Exception("Could not find ChatGPT upload menu item.");

            uploadItemName = uploadItem.Current.Name ?? "";
            ClickElementWithMouse(uploadItem);

            WaitForFileDialog(root, waitSeconds, out fileNameEdit, out openButton);
        }
        if (fileNameEdit == null || openButton == null)
        {
            throw new Exception("Could not find the Windows file picker after opening ChatGPT upload.");
        }

        object valuePatternObject;
        if (!fileNameEdit.TryGetCurrentPattern(ValuePattern.Pattern, out valuePatternObject))
        {
            throw new Exception("File picker filename field does not expose ValuePattern.");
        }

        ((ValuePattern)valuePatternObject).SetValue(fullPath);
        Thread.Sleep(250);
        InvokeElement(openButton);

        var basename = Path.GetFileName(fullPath);
        var attachments = WaitForAttachment(hwnd, basename, waitSeconds);
        var uploaded = attachments.Any(a => AttachmentNameMatchesFile(a.Name, basename)) ||
            attachments.Count > before.Count;

        var sb = new StringBuilder();
        sb.Append("{");
        sb.Append("\"ok\":true,");
        sb.Append("\"windowTitle\":").Append(Json(root.Current.Name)).Append(",");
        sb.Append("\"method\":\"FilePicker\",");
        sb.Append("\"filePath\":").Append(Json(fullPath)).Append(",");
        sb.Append("\"fileName\":").Append(Json(basename)).Append(",");
        sb.Append("\"uploadMenuItem\":").Append(Json(uploadItemName)).Append(",");
        sb.Append("\"attachmentCountBefore\":").Append(before.Count).Append(",");
        sb.Append("\"uploaded\":").Append(uploaded ? "true" : "false").Append(",");
        sb.Append("\"attachments\":").Append(AttachmentsJsonArray(attachments));
        sb.Append("}");
        return sb.ToString();
    }

    public static string RemoveAttachmentsJson(string titleContains, string nameContains, int maxAttachments)
    {
        var hwnd = FindChromeWindow(titleContains);
        SetForegroundWindow(hwnd);
        Thread.Sleep(200);

        var root = AutomationElement.FromHandle(hwnd);
        if (root == null) throw new Exception("Chrome window was found, but UI Automation could not attach to it.");

        var attachments = FindAttachments(root);
        if (!String.IsNullOrWhiteSpace(nameContains))
        {
            attachments = attachments
                .Where(a => a.Name.IndexOf(nameContains, StringComparison.OrdinalIgnoreCase) >= 0)
                .ToList();
        }

        var targets = attachments
            .Where(a => a.RemoveElement != null)
            .OrderByDescending(a => a.Top)
            .Take(Math.Max(1, maxAttachments))
            .ToList();

        var removed = new List<AttachmentInfo>();
        foreach (var attachment in targets)
        {
            InvokeElement(attachment.RemoveElement);
            removed.Add(attachment);
            Thread.Sleep(450);
        }

        Thread.Sleep(500);
        root = AutomationElement.FromHandle(hwnd);
        var remaining = FindAttachments(root);

        var sb = new StringBuilder();
        sb.Append("{");
        sb.Append("\"ok\":true,");
        sb.Append("\"windowTitle\":").Append(Json(root.Current.Name)).Append(",");
        sb.Append("\"removedCount\":").Append(removed.Count).Append(",");
        sb.Append("\"removed\":").Append(AttachmentsJsonArray(removed)).Append(",");
        sb.Append("\"remainingCount\":").Append(remaining.Count).Append(",");
        sb.Append("\"remaining\":").Append(AttachmentsJsonArray(remaining));
        sb.Append("}");
        return sb.ToString();
    }

    public static string StateJson(string titleContains)
    {
        var hwnd = FindChromeWindow(titleContains);
        var root = AutomationElement.FromHandle(hwnd);
        if (root == null) throw new Exception("Chrome window was found, but UI Automation could not attach to it.");

        var prompt = FindVisibleByAutomationId(root, "prompt-textarea");
        var promptTop = prompt == null
            ? Double.PositiveInfinity
            : prompt.Current.BoundingRectangle.Top;
        var document = FindByAutomationId(root, "RootWebArea") ?? root;
        var main = FindByAutomationId(root, "main") ?? document;
        var items = ReadVisibleTextItems(main, promptTop);
        var downloadButtons = FindDownloadButtons(document, promptTop);
        var attachments = FindAttachments(root);
        var codeButtons = FindCodeCopyButtons(document, promptTop);
        var stopButtons = FindButtonsByName(document, promptTop, new string[] {
            "Stop", "หยุด", "หยุดสร้าง", "Stop generating"
        });

        var sb = new StringBuilder();
        sb.Append("{");
        sb.Append("\"ok\":true,");
        sb.Append("\"windowTitle\":").Append(Json(root.Current.Name)).Append(",");
        sb.Append("\"hasPrompt\":").Append(prompt == null ? "false" : "true").Append(",");
        sb.Append("\"promptValue\":").Append(Json(ReadValue(prompt))).Append(",");
        sb.Append("\"visibleTextHash\":").Append(Json(Sha256(string.Join("\n", items.Select(i => i.Name))))).Append(",");
        sb.Append("\"visibleTextItemCount\":").Append(items.Count).Append(",");
        sb.Append("\"downloadButtonCount\":").Append(downloadButtons.Count).Append(",");
        sb.Append("\"attachmentCount\":").Append(attachments.Count).Append(",");
        sb.Append("\"codeBlockCount\":").Append(codeButtons.Count).Append(",");
        sb.Append("\"isGenerating\":").Append(stopButtons.Count > 0 ? "true" : "false").Append(",");
        sb.Append("\"downloadButtons\":").Append(DownloadButtonsJson(downloadButtons)).Append(",");
        sb.Append("\"attachments\":").Append(AttachmentsJsonArray(attachments)).Append(",");
        sb.Append("\"codeBlocks\":").Append(CodeButtonsJson(codeButtons)).Append(",");
        sb.Append("\"stopButtons\":").Append(SimpleButtonsJson(stopButtons));
        sb.Append("}");
        return sb.ToString();
    }

    public static string SendJson(string titleContains, string message, bool submit, bool allowMismatch)
    {
        if (String.IsNullOrWhiteSpace(message)) throw new Exception("Message is empty.");

        var hwnd = FindChromeWindow(titleContains);
        SetForegroundWindow(hwnd);
        Thread.Sleep(200);

        var root = AutomationElement.FromHandle(hwnd);
        if (root == null) throw new Exception("Chrome window was found, but UI Automation could not attach to it.");

        var prompt = FindVisibleByAutomationId(root, "prompt-textarea");
        if (prompt == null) throw new Exception("Could not find ChatGPT prompt-textarea. Open ChatGPT in Chrome first.");

        var writeResult = WritePromptWithVerification(prompt, message);
        if (!writeResult.Verified && !allowMismatch)
        {
            throw new Exception("Message verification failed before submit. Expected hash "
                + Sha256(NormalizeText(message))
                + " but prompt hash was "
                + Sha256(NormalizeText(writeResult.ActualValue))
                + ". Nothing was submitted.");
        }

        if (submit)
        {
            prompt.SetFocus();
            SendKeys.SendWait("{ENTER}");
            Thread.Sleep(350);
        }

        var sb = new StringBuilder();
        sb.Append("{");
        sb.Append("\"ok\":true,");
        sb.Append("\"submitted\":").Append(submit ? "true" : "false").Append(",");
        sb.Append("\"windowTitle\":").Append(Json(root.Current.Name)).Append(",");
        sb.Append("\"message\":").Append(Json(message)).Append(",");
        sb.Append("\"messageHash\":").Append(Json(Sha256(NormalizeText(message)))).Append(",");
        sb.Append("\"writeMethod\":").Append(Json(writeResult.Method)).Append(",");
        sb.Append("\"usedClipboardFallback\":").Append(writeResult.UsedClipboard ? "true" : "false").Append(",");
        sb.Append("\"verifiedBeforeSubmit\":").Append(writeResult.Verified ? "true" : "false").Append(",");
        sb.Append("\"promptHashBeforeSubmit\":").Append(Json(Sha256(NormalizeText(writeResult.ActualValue)))).Append(",");
        sb.Append("\"promptValueBeforeSubmit\":").Append(Json(writeResult.ActualValue));
        sb.Append("}");
        return sb.ToString();
    }

    public static string DownloadJson(string titleContains, string nameContains, string downloadDirectory, int waitSeconds, int maxDownloads)
    {
        var hwnd = FindChromeWindow(titleContains);
        SetForegroundWindow(hwnd);
        Thread.Sleep(200);

        var root = AutomationElement.FromHandle(hwnd);
        if (root == null) throw new Exception("Chrome window was found, but UI Automation could not attach to it.");

        var prompt = FindVisibleByAutomationId(root, "prompt-textarea");
        var promptTop = prompt == null
            ? Double.PositiveInfinity
            : prompt.Current.BoundingRectangle.Top;

        var document = FindByAutomationId(root, "RootWebArea") ?? root;
        var buttons = FindDownloadButtons(document, promptTop);
        if (!String.IsNullOrWhiteSpace(nameContains))
        {
            buttons = buttons
                .Where(b => b.Name.IndexOf(nameContains, StringComparison.OrdinalIgnoreCase) >= 0)
                .ToList();
        }

        buttons = buttons
            .OrderByDescending(b => b.Top)
            .Take(Math.Max(1, maxDownloads))
            .ToList();

        var directory = ResolveDownloadDirectory(downloadDirectory);
        var before = SnapshotFiles(directory);
        var clicked = new List<DownloadButtonInfo>();

        foreach (var button in buttons)
        {
            InvokeElement(button.Element);
            clicked.Add(button);
            Thread.Sleep(500);
        }

        var downloaded = WaitForNewDownloads(directory, before, waitSeconds);

        var sb = new StringBuilder();
        sb.Append("{");
        sb.Append("\"ok\":true,");
        sb.Append("\"windowTitle\":").Append(Json(root.Current.Name)).Append(",");
        sb.Append("\"downloadDirectory\":").Append(Json(directory)).Append(",");
        sb.Append("\"clicked\":").Append(DownloadButtonsJson(clicked)).Append(",");
        sb.Append("\"downloadedFiles\":").Append(FilesJson(downloaded)).Append(",");
        sb.Append("\"downloadedFileCount\":").Append(downloaded.Count);
        sb.Append("}");
        return sb.ToString();
    }

    public static string CodeBlocksJson(string titleContains, int maxCodeBlocks, int offsetFromLatest)
    {
        var hwnd = FindChromeWindow(titleContains);
        SetForegroundWindow(hwnd);
        Thread.Sleep(200);

        var root = AutomationElement.FromHandle(hwnd);
        if (root == null) throw new Exception("Chrome window was found, but UI Automation could not attach to it.");

        var prompt = FindVisibleByAutomationId(root, "prompt-textarea");
        var promptTop = prompt == null
            ? Double.PositiveInfinity
            : prompt.Current.BoundingRectangle.Top;
        var document = FindByAutomationId(root, "RootWebArea") ?? root;
        var allButtons = FindCodeCopyButtons(document, promptTop);
        var buttons = allButtons
            .OrderByDescending(b => b.Top)
            .Skip(Math.Max(0, offsetFromLatest))
            .ToList();

        string oldText = "";
        bool hadText = TryGetClipboardText(out oldText);
        var blocks = new List<CodeBlockInfo>();

        try
        {
            foreach (var button in buttons)
            {
                TryClearClipboard();
                Thread.Sleep(80);
                InvokeElement(button.Element);
                Thread.Sleep(350);

                string codeText = "";
                TryGetClipboardText(out codeText);

                if (!String.IsNullOrEmpty(codeText))
                {
                    blocks.Add(new CodeBlockInfo {
                        Index = button.Index,
                        Name = button.Name,
                        Top = button.Top,
                        Left = button.Left,
                        Width = button.Width,
                        Height = button.Height,
                        Text = codeText
                    });
                }

                if (blocks.Count >= Math.Max(1, maxCodeBlocks)) break;
            }
        }
        finally
        {
            TryRestoreClipboardText(hadText, oldText);
        }

        var sb = new StringBuilder();
        sb.Append("{");
        sb.Append("\"ok\":true,");
        sb.Append("\"windowTitle\":").Append(Json(root.Current.Name)).Append(",");
        sb.Append("\"totalCodeBlocks\":").Append(allButtons.Count).Append(",");
        sb.Append("\"returnedCodeBlocks\":").Append(blocks.Count).Append(",");
        sb.Append("\"codeBlocks\":").Append(CodeBlocksJsonArray(blocks));
        sb.Append("}");
        return sb.ToString();
    }

    public static string LastResponseJson(string titleContains)
    {
        var hwnd = FindChromeWindow(titleContains);
        var root = AutomationElement.FromHandle(hwnd);
        if (root == null) throw new Exception("Chrome window was found, but UI Automation could not attach to it.");

        var prompt = FindVisibleByAutomationId(root, "prompt-textarea");
        var promptTop = prompt == null
            ? Double.PositiveInfinity
            : prompt.Current.BoundingRectangle.Top;
        var promptLeft = prompt == null
            ? (root.Current.BoundingRectangle.Width / 2.0)
            : prompt.Current.BoundingRectangle.Left;
        var document = FindByAutomationId(root, "RootWebArea") ?? root;
        var messages = FindMessageGroups(document, promptTop, promptLeft);
        var assistants = messages.Where(m => m.Role == "assistant").OrderByDescending(m => m.Top).ToList();
        var latest = assistants.FirstOrDefault();

        var sb = new StringBuilder();
        sb.Append("{");
        sb.Append("\"ok\":true,");
        sb.Append("\"windowTitle\":").Append(Json(root.Current.Name)).Append(",");
        sb.Append("\"messageGroupCount\":").Append(messages.Count).Append(",");
        sb.Append("\"assistantMessageCount\":").Append(assistants.Count).Append(",");
        if (latest == null)
        {
            sb.Append("\"lastResponse\":null,");
            sb.Append("\"lastResponseText\":\"\"");
        }
        else
        {
            sb.Append("\"lastResponse\":").Append(MessageInfoJson(latest)).Append(",");
            sb.Append("\"lastResponseText\":").Append(Json(latest.Text));
        }
        sb.Append("}");
        return sb.ToString();
    }

    public static string StopGenerationJson(string titleContains)
    {
        var hwnd = FindChromeWindow(titleContains);
        SetForegroundWindow(hwnd);
        Thread.Sleep(200);

        var root = AutomationElement.FromHandle(hwnd);
        if (root == null) throw new Exception("Chrome window was found, but UI Automation could not attach to it.");

        var prompt = FindVisibleByAutomationId(root, "prompt-textarea");
        var promptTop = prompt == null
            ? Double.PositiveInfinity
            : prompt.Current.BoundingRectangle.Top;
        var document = FindByAutomationId(root, "RootWebArea") ?? root;
        var stopButtons = FindButtonsByName(document, promptTop, new string[] {
            "Stop", "หยุด", "หยุดสร้าง", "Stop generating"
        }).OrderByDescending(b => b.Top).ToList();

        bool clicked = false;
        if (stopButtons.Count > 0)
        {
            InvokeElement(stopButtons[0].Element);
            clicked = true;
            Thread.Sleep(350);
        }

        var sb = new StringBuilder();
        sb.Append("{");
        sb.Append("\"ok\":true,");
        sb.Append("\"windowTitle\":").Append(Json(root.Current.Name)).Append(",");
        sb.Append("\"clicked\":").Append(clicked ? "true" : "false").Append(",");
        sb.Append("\"buttons\":").Append(SimpleButtonsJson(stopButtons));
        sb.Append("}");
        return sb.ToString();
    }

    private static PromptWriteResult WritePromptWithVerification(AutomationElement prompt, string message)
    {
        prompt.SetFocus();
        Thread.Sleep(100);

        object valuePatternObject;
        if (!prompt.TryGetCurrentPattern(ValuePattern.Pattern, out valuePatternObject))
        {
            throw new Exception("ChatGPT prompt does not expose ValuePattern.");
        }

        var valuePattern = (ValuePattern)valuePatternObject;
        valuePattern.SetValue(message);
        Thread.Sleep(350);

        var actual = ReadValue(prompt);
        if (SamePromptText(message, actual))
        {
            return new PromptWriteResult {
                Method = "ValuePattern.SetValue",
                UsedClipboard = false,
                Verified = true,
                ActualValue = actual
            };
        }

        var fallback = TryClipboardPaste(prompt, valuePattern, message);
        if (SamePromptText(message, fallback))
        {
            return new PromptWriteResult {
                Method = "ClipboardPaste",
                UsedClipboard = true,
                Verified = true,
                ActualValue = fallback
            };
        }

        return new PromptWriteResult {
            Method = "ValuePattern.SetValue+ClipboardPaste",
            UsedClipboard = true,
            Verified = false,
            ActualValue = fallback
        };
    }

    private static string TryClipboardPaste(AutomationElement prompt, ValuePattern valuePattern, string message)
    {
        bool hadText = false;
        string oldText = "";
        try
        {
            hadText = Clipboard.ContainsText(TextDataFormat.UnicodeText);
            if (hadText) oldText = Clipboard.GetText(TextDataFormat.UnicodeText);
        }
        catch
        {
            hadText = false;
            oldText = "";
        }

        try
        {
            valuePattern.SetValue("");
            Thread.Sleep(100);
            prompt.SetFocus();
            Clipboard.SetText(message, TextDataFormat.UnicodeText);
            Thread.Sleep(100);
            SendKeys.SendWait("^v");
            Thread.Sleep(450);
            return ReadValue(prompt);
        }
        finally
        {
            try
            {
                if (hadText) Clipboard.SetText(oldText, TextDataFormat.UnicodeText);
            }
            catch
            {
                // Leave the pasted message on the clipboard if Windows rejects clipboard restore.
            }
        }
    }

    private static bool SamePromptText(string expected, string actual)
    {
        return String.Equals(NormalizeText(expected), NormalizeText(actual), StringComparison.Ordinal);
    }

    private static string NormalizeText(string text)
    {
        return (text ?? "").Replace("\r\n", "\n").Replace("\r", "\n");
    }

    private static IntPtr FindChromeWindow(string titleContains)
    {
        var processes = Process.GetProcessesByName("chrome")
            .Where(p => p.MainWindowHandle != IntPtr.Zero && !String.IsNullOrWhiteSpace(p.MainWindowTitle))
            .ToList();

        if (String.IsNullOrWhiteSpace(titleContains))
        {
            var activeChatGptWindows = processes
                .Where(p => WindowHasVisibleChatGptPrompt(p.MainWindowHandle))
                .ToList();

            if (activeChatGptWindows.Count == 1)
            {
                return activeChatGptWindows[0].MainWindowHandle;
            }

            if (activeChatGptWindows.Count > 1)
            {
                throw new Exception("AMBIGUOUS_CHATGPT_TARGET: Multiple Chrome windows have an active visible ChatGPT prompt. Pass WindowTitleContains to choose one. Matches: "
                    + string.Join(" | ", activeChatGptWindows.Select(p => p.MainWindowTitle)));
            }

            if (processes.Count == 0)
            {
                throw new Exception("No visible Chrome window found. Open ChatGPT in Chrome first.");
            }

            throw new Exception("CHATGPT_ACTIVE_TAB_NOT_FOUND: Chrome is open, but no active tab has a visible ChatGPT prompt. Select the ChatGPT tab or pass WindowTitleContains to activate a matching ChatGPT tab.");
        }

        var ordered = processes
            .OrderByDescending(p => p.MainWindowTitle.IndexOf(titleContains, StringComparison.OrdinalIgnoreCase) >= 0)
            .ThenByDescending(p => p.MainWindowTitle.IndexOf("ChatGPT", StringComparison.OrdinalIgnoreCase) >= 0)
            .ThenByDescending(p => p.MainWindowTitle.IndexOf("Google Chrome", StringComparison.OrdinalIgnoreCase) >= 0)
            .ToList();

        foreach (var process in ordered)
        {
            var hwnd = process.MainWindowHandle;
            SetForegroundWindow(hwnd);
            Thread.Sleep(150);

            var root = AutomationElement.FromHandle(hwnd);
            if (root == null) continue;

            if (FindVisibleByAutomationId(root, "prompt-textarea") != null)
            {
                return hwnd;
            }

            if (TryActivateChatGptTab(root, titleContains))
            {
                Thread.Sleep(700);
                root = AutomationElement.FromHandle(hwnd);
                if (root != null && FindVisibleByAutomationId(root, "prompt-textarea") != null)
                {
                    return hwnd;
                }
            }
        }

        if (ordered.Count == 0)
        {
            throw new Exception("No visible Chrome window found. Open ChatGPT in Chrome first.");
        }

        throw new Exception("Chrome is open, but no active ChatGPT tab with a visible prompt-textarea was found. Select the ChatGPT tab or keep a dedicated ChatGPT Chrome window open.");
    }

    private static bool WindowHasVisibleChatGptPrompt(IntPtr hwnd)
    {
        var root = AutomationElement.FromHandle(hwnd);
        if (root == null) return false;
        return FindVisibleByAutomationId(root, "prompt-textarea") != null;
    }

    private static AutomationElement FindByAutomationId(AutomationElement root, string automationId)
    {
        return root.FindFirst(
            TreeScope.Descendants,
            new PropertyCondition(AutomationElement.AutomationIdProperty, automationId)
        );
    }

    private static AutomationElement FindVisibleByAutomationId(AutomationElement root, string automationId)
    {
        var matches = root.FindAll(
            TreeScope.Descendants,
            new PropertyCondition(AutomationElement.AutomationIdProperty, automationId)
        );

        for (int i = 0; i < matches.Count; i++)
        {
            var element = matches[i];

            try
            {
                var rect = element.Current.BoundingRectangle;
                if (rect.Width <= 0 || rect.Height <= 0) continue;
                if (element.Current.IsOffscreen) continue;
                return element;
            }
            catch
            {
                continue;
            }
        }

        return null;
    }

    private static bool TryActivateChatGptTab(AutomationElement root, string titleContains)
    {
        var all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
        var candidates = new List<AutomationElement>();

        for (int i = 0; i < all.Count; i++)
        {
            var element = all[i];
            if (element.Current.ControlType != ControlType.TabItem) continue;

            string name = element.Current.Name ?? "";
            if (String.IsNullOrWhiteSpace(name)) continue;

            bool matchesTitle = !String.IsNullOrWhiteSpace(titleContains) &&
                name.IndexOf(titleContains, StringComparison.OrdinalIgnoreCase) >= 0;
            bool matchesChatGpt = name.IndexOf("ChatGPT", StringComparison.OrdinalIgnoreCase) >= 0;
            if (!matchesTitle && !matchesChatGpt) continue;

            try
            {
                var rect = element.Current.BoundingRectangle;
                if (rect.Width <= 0 || rect.Height <= 0) continue;
                if (element.Current.IsOffscreen) continue;
            }
            catch
            {
                continue;
            }

            candidates.Add(element);
        }

        if (candidates.Count == 0) return false;

        var target = candidates[0];
        object selectionObject;
        if (target.TryGetCurrentPattern(SelectionItemPattern.Pattern, out selectionObject))
        {
            ((SelectionItemPattern)selectionObject).Select();
            return true;
        }

        ClickElementWithMouse(target);
        return true;
    }

    private static string ReadValue(AutomationElement element)
    {
        if (element == null) return "";
        object valuePatternObject;
        if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out valuePatternObject)) return "";
        return ((ValuePattern)valuePatternObject).Current.Value ?? "";
    }

    private static List<TextItem> ReadVisibleTextItems(AutomationElement root, double promptTop)
    {
        var all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
        var items = new List<TextItem>();

        for (int i = 0; i < all.Count; i++)
        {
            var element = all[i];
            string name = element.Current.Name ?? "";
            if (String.IsNullOrWhiteSpace(name)) continue;

            var controlType = element.Current.ControlType;
            bool isReadable =
                controlType == ControlType.Text ||
                controlType == ControlType.DataItem ||
                controlType == ControlType.Edit;

            if (!isReadable) continue;
            if ((element.Current.AutomationId ?? "") == "prompt-textarea") continue;
            if (element.Current.BoundingRectangle.Top >= promptTop) continue;

            items.Add(new TextItem {
                Index = i,
                ControlType = controlType.ProgrammaticName,
                Name = name
            });
        }

        return items;
    }

    private static List<DownloadButtonInfo> FindDownloadButtons(AutomationElement root, double promptTop)
    {
        var all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
        var buttons = new List<DownloadButtonInfo>();

        for (int i = 0; i < all.Count; i++)
        {
            var element = all[i];
            string name = element.Current.Name ?? "";
            if (String.IsNullOrWhiteSpace(name)) continue;

            var controlType = element.Current.ControlType;
            bool clickable = controlType == ControlType.Button || controlType == ControlType.Hyperlink;
            if (!clickable) continue;
            if (!IsDownloadCandidate(name)) continue;

            var rect = element.Current.BoundingRectangle;
            if (rect.Width <= 0 || rect.Height <= 0) continue;
            if (rect.Top >= promptTop) continue;

            object invokeObject;
            buttons.Add(new DownloadButtonInfo {
                Index = i,
                Name = name,
                ControlType = controlType.ProgrammaticName,
                Left = rect.Left,
                Top = rect.Top,
                Width = rect.Width,
                Height = rect.Height,
                CanInvoke = element.TryGetCurrentPattern(InvokePattern.Pattern, out invokeObject),
                Element = element
            });
        }

        return buttons;
    }

    private static AutomationElement FindUploadMenuItem(AutomationElement root)
    {
        var all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);

        for (int i = 0; i < all.Count; i++)
        {
            var element = all[i];
            string name = element.Current.Name ?? "";
            if (String.IsNullOrWhiteSpace(name)) continue;
            if (element.Current.ControlType != ControlType.MenuItem) continue;

            var lower = name.ToLowerInvariant();
            bool matches =
                name.IndexOf("เพิ่มรูปภาพและไฟล์", StringComparison.OrdinalIgnoreCase) >= 0 ||
                lower.IndexOf("add photos and files") >= 0 ||
                lower.IndexOf("upload files") >= 0 ||
                lower.IndexOf("upload file") >= 0;
            if (!matches) continue;

            var rect = element.Current.BoundingRectangle;
            if (rect.Width <= 0 || rect.Height <= 0) continue;

            return element;
        }

        return null;
    }

    private static void WaitForFileDialog(
        AutomationElement root,
        int waitSeconds,
        out AutomationElement fileNameEdit,
        out AutomationElement openButton)
    {
        fileNameEdit = null;
        openButton = null;
        var deadline = DateTime.UtcNow.AddSeconds(Math.Max(1, waitSeconds));

        while (DateTime.UtcNow < deadline)
        {
            AutomationElementCollection all;
            try
            {
                all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
            }
            catch
            {
                Thread.Sleep(300);
                continue;
            }

            AutomationElement candidateEdit = null;
            AutomationElement candidateOpen = null;

            for (int i = 0; i < all.Count; i++)
            {
                AutomationElement element;
                string name;
                string automationId;
                System.Windows.Rect rect;
                ControlType controlType;
                try
                {
                    element = all[i];
                    name = element.Current.Name ?? "";
                    automationId = element.Current.AutomationId ?? "";
                    rect = element.Current.BoundingRectangle;
                    controlType = element.Current.ControlType;
                    if (rect.Width <= 0 || rect.Height <= 0) continue;
                }
                catch
                {
                    continue;
                }

                if (candidateEdit == null &&
                    controlType == ControlType.Edit &&
                    (automationId == "1148" ||
                        name.IndexOf("ชื่อแฟ้ม", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        name.IndexOf("File name", StringComparison.OrdinalIgnoreCase) >= 0))
                {
                    candidateEdit = element;
                }

                if (candidateOpen == null &&
                    controlType == ControlType.Button &&
                    (automationId == "1" ||
                        String.Equals(name, "เปิด", StringComparison.OrdinalIgnoreCase) ||
                        String.Equals(name, "Open", StringComparison.OrdinalIgnoreCase)))
                {
                    candidateOpen = element;
                }
            }

            if (candidateEdit != null && candidateOpen != null)
            {
                fileNameEdit = candidateEdit;
                openButton = candidateOpen;
                return;
            }

            Thread.Sleep(300);
        }
    }

    private static List<AttachmentInfo> WaitForAttachment(IntPtr hwnd, string fileName, int waitSeconds)
    {
        var deadline = DateTime.UtcNow.AddSeconds(Math.Max(1, waitSeconds));
        var latest = new List<AttachmentInfo>();

        while (DateTime.UtcNow < deadline)
        {
            try
            {
                var root = AutomationElement.FromHandle(hwnd);
                latest = FindAttachments(root);
            }
            catch
            {
                latest = new List<AttachmentInfo>();
            }

            var match = latest.FirstOrDefault(a => AttachmentNameMatchesFile(a.Name, fileName));
            if (match != null && !match.IsUploading)
            {
                return latest;
            }

            Thread.Sleep(500);
        }

        try
        {
            var finalRoot = AutomationElement.FromHandle(hwnd);
            return FindAttachments(finalRoot);
        }
        catch
        {
            return latest;
        }
    }

    private static List<AttachmentInfo> FindAttachments(AutomationElement root)
    {
        AutomationElementCollection all;
        try
        {
            all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
        }
        catch
        {
            return new List<AttachmentInfo>();
        }

        var byName = new Dictionary<string, AttachmentInfo>(StringComparer.OrdinalIgnoreCase);

        for (int i = 0; i < all.Count; i++)
        {
            AutomationElement element;
            string name;
            string className;
            System.Windows.Rect rect;
            try
            {
                element = all[i];
                name = element.Current.Name ?? "";
                className = element.Current.ClassName ?? "";
                if (String.IsNullOrWhiteSpace(name)) continue;

                rect = element.Current.BoundingRectangle;
                if (rect.Width <= 0 || rect.Height <= 0) continue;
            }
            catch
            {
                continue;
            }

            bool isFileTile = className.IndexOf("file-tile", StringComparison.OrdinalIgnoreCase) >= 0;
            bool isRemoveButton = IsRemoveAttachmentButton(name);
            string attachmentName = isRemoveButton ? ExtractAttachmentNameFromRemoveButton(name) : name.Trim();

            if (!isFileTile && !isRemoveButton) continue;
            if (String.IsNullOrWhiteSpace(attachmentName)) continue;

            AttachmentInfo info;
            if (!byName.TryGetValue(attachmentName, out info))
            {
                info = new AttachmentInfo {
                    Index = i,
                    Name = attachmentName,
                    Left = rect.Left,
                    Top = rect.Top,
                    Width = rect.Width,
                    Height = rect.Height,
                    IsUploading = false,
                    RemoveButtonName = "",
                    RemoveElement = null
                };
                byName[attachmentName] = info;
            }

            if (isFileTile)
            {
                info.Index = i;
                info.Left = rect.Left;
                info.Top = rect.Top;
                info.Width = rect.Width;
                info.Height = rect.Height;
                if (className.IndexOf("cursor-wait", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    info.IsUploading = true;
                }
            }

            if (isRemoveButton && element.Current.ControlType == ControlType.Button)
            {
                info.RemoveButtonName = name;
                info.RemoveElement = element;
            }
        }

        return byName.Values
            .Where(a => a.RemoveElement != null)
            .OrderBy(a => a.Top)
            .ThenBy(a => a.Left)
            .ToList();
    }

    private static bool AttachmentNameMatchesFile(string attachmentName, string fileName)
    {
        if (String.IsNullOrWhiteSpace(attachmentName) || String.IsNullOrWhiteSpace(fileName)) return false;
        if (String.Equals(attachmentName, fileName, StringComparison.OrdinalIgnoreCase)) return true;

        var expectedStem = Path.GetFileNameWithoutExtension(fileName);
        var expectedExt = Path.GetExtension(fileName);
        var actualStem = Path.GetFileNameWithoutExtension(attachmentName);
        var actualExt = Path.GetExtension(attachmentName);
        if (!String.Equals(expectedExt, actualExt, StringComparison.OrdinalIgnoreCase)) return false;

        return actualStem.StartsWith(expectedStem, StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsRemoveAttachmentButton(string name)
    {
        if (String.IsNullOrWhiteSpace(name)) return false;
        return name.IndexOf("ลบไฟล์", StringComparison.OrdinalIgnoreCase) >= 0 ||
            name.IndexOf("Remove file", StringComparison.OrdinalIgnoreCase) >= 0;
    }

    private static string ExtractAttachmentNameFromRemoveButton(string name)
    {
        if (String.IsNullOrWhiteSpace(name)) return "";

        var colon = name.IndexOf(":");
        if (colon >= 0 && colon + 1 < name.Length)
        {
            return name.Substring(colon + 1).Trim();
        }

        return name
            .Replace("ลบไฟล์", "")
            .Replace("Remove file", "")
            .Trim();
    }

    private static List<CodeButtonInfo> FindCodeCopyButtons(AutomationElement root, double promptTop)
    {
        var all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
        var buttons = new List<CodeButtonInfo>();

        for (int i = 0; i < all.Count; i++)
        {
            var element = all[i];
            string name = element.Current.Name ?? "";
            string className = element.Current.ClassName ?? "";

            bool isCopyButton =
                String.Equals(name, "คัดลอก", StringComparison.OrdinalIgnoreCase) ||
                String.Equals(name, "Copy", StringComparison.OrdinalIgnoreCase);
            if (!isCopyButton) continue;
            if (element.Current.ControlType != ControlType.Button) continue;
            if (name.IndexOf("คำตอบ", StringComparison.OrdinalIgnoreCase) >= 0) continue;
            if (name.IndexOf("ข้อความ", StringComparison.OrdinalIgnoreCase) >= 0) continue;

            var rect = element.Current.BoundingRectangle;
            if (rect.Width <= 0 || rect.Height <= 0) continue;
            if (rect.Top >= promptTop) continue;

            object invokeObject;
            bool canInvoke = element.TryGetCurrentPattern(InvokePattern.Pattern, out invokeObject);
            if (!canInvoke) continue;

            buttons.Add(new CodeButtonInfo {
                Index = i,
                Name = name,
                ClassName = className,
                Left = rect.Left,
                Top = rect.Top,
                Width = rect.Width,
                Height = rect.Height,
                Element = element
            });
        }

        return buttons;
    }

    private static List<SimpleButtonInfo> FindButtonsByName(AutomationElement root, double promptTop, string[] names)
    {
        var all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
        var buttons = new List<SimpleButtonInfo>();

        for (int i = 0; i < all.Count; i++)
        {
            var element = all[i];
            string name = element.Current.Name ?? "";
            if (String.IsNullOrWhiteSpace(name)) continue;
            if (element.Current.ControlType != ControlType.Button) continue;

            bool matches = false;
            foreach (var candidate in names)
            {
                if (name.IndexOf(candidate, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    matches = true;
                    break;
                }
            }
            if (!matches) continue;

            var rect = element.Current.BoundingRectangle;
            if (rect.Width <= 0 || rect.Height <= 0) continue;
            if (rect.Top >= promptTop) continue;

            object invokeObject;
            buttons.Add(new SimpleButtonInfo {
                Index = i,
                Name = name,
                ControlType = element.Current.ControlType.ProgrammaticName,
                CanInvoke = element.TryGetCurrentPattern(InvokePattern.Pattern, out invokeObject),
                Left = rect.Left,
                Top = rect.Top,
                Width = rect.Width,
                Height = rect.Height,
                Element = element
            });
        }

        return buttons;
    }

    private static List<MessageInfo> FindMessageGroups(AutomationElement root, double promptTop, double promptLeft)
    {
        var all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
        var messages = new List<MessageInfo>();

        for (int i = 0; i < all.Count; i++)
        {
            var element = all[i];
            string name = element.Current.Name ?? "";
            string className = element.Current.ClassName ?? "";
            if (element.Current.ControlType != ControlType.Group) continue;
            if (className.IndexOf("text-message", StringComparison.OrdinalIgnoreCase) < 0) continue;

            var rect = element.Current.BoundingRectangle;
            if (rect.Width <= 0 || rect.Height <= 0) continue;
            if (rect.Top >= promptTop) continue;

            if (String.IsNullOrWhiteSpace(name))
            {
                name = CollectReadableDescendantText(element);
            }
            if (String.IsNullOrWhiteSpace(name)) continue;

            // In ChatGPT's current layout assistant turns are left-aligned near the composer,
            // while user turns are right-aligned. Keep this heuristic local and explicit.
            string role = rect.Left <= promptLeft + 50 ? "assistant" : "user";
            messages.Add(new MessageInfo {
                Index = i,
                Role = role,
                Text = name,
                Left = rect.Left,
                Top = rect.Top,
                Width = rect.Width,
                Height = rect.Height
            });
        }

        return messages;
    }

    private static string CollectReadableDescendantText(AutomationElement root)
    {
        var all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
        var parts = new List<string>();

        for (int i = 0; i < all.Count; i++)
        {
            var element = all[i];
            var controlType = element.Current.ControlType;
            if (controlType != ControlType.Text &&
                controlType != ControlType.DataItem &&
                controlType != ControlType.Edit)
            {
                continue;
            }

            string name = element.Current.Name ?? "";
            if (String.IsNullOrWhiteSpace(name)) continue;
            if ((element.Current.AutomationId ?? "") == "prompt-textarea") continue;
            parts.Add(name);
        }

        return string.Join("\n", parts);
    }

    private static bool IsDownloadCandidate(string name)
    {
        if (String.Equals(name, "Download apps", StringComparison.OrdinalIgnoreCase)) return false;
        if (name.StartsWith("Download ", StringComparison.OrdinalIgnoreCase)) return true;
        if (name.IndexOf("ดาวน์โหลด", StringComparison.OrdinalIgnoreCase) >= 0) return true;

        string lower = name.ToLowerInvariant();
        if (lower.IndexOf("download") < 0) return false;

        string[] extensions = new string[] {
            ".txt", ".csv", ".json", ".zip", ".pdf", ".docx", ".xlsx",
            ".pptx", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".html",
            ".md", ".py", ".js", ".ts", ".css", ".xml", ".yaml", ".yml"
        };

        foreach (string extension in extensions)
        {
            if (lower.IndexOf(extension) >= 0) return true;
        }

        return false;
    }

    private static void InvokeElement(AutomationElement element)
    {
        object invokeObject;
        if (!element.TryGetCurrentPattern(InvokePattern.Pattern, out invokeObject))
        {
            element.SetFocus();
            SendKeys.SendWait("{ENTER}");
            return;
        }

        ((InvokePattern)invokeObject).Invoke();
    }

    private static void ClickElementWithMouse(AutomationElement element)
    {
        var rect = element.Current.BoundingRectangle;
        if (rect.Width <= 0 || rect.Height <= 0)
        {
            InvokeElement(element);
            return;
        }

        int x = (int)(rect.Left + rect.Width / 2.0);
        int y = (int)(rect.Top + rect.Height / 2.0);
        SetCursorPos(x, y);
        Thread.Sleep(100);
        mouse_event(MOUSEEVENTF_LEFTDOWN, (uint)x, (uint)y, 0, UIntPtr.Zero);
        Thread.Sleep(70);
        mouse_event(MOUSEEVENTF_LEFTUP, (uint)x, (uint)y, 0, UIntPtr.Zero);
    }

    private static bool TryGetClipboardText(out string text)
    {
        text = "";
        for (int attempt = 0; attempt < 5; attempt++)
        {
            try
            {
                if (!Clipboard.ContainsText(TextDataFormat.UnicodeText)) return false;
                text = Clipboard.GetText(TextDataFormat.UnicodeText);
                return true;
            }
            catch
            {
                Thread.Sleep(120);
            }
        }

        text = "";
        return false;
    }

    private static void TryRestoreClipboardText(bool hadText, string text)
    {
        if (!hadText) return;

        for (int attempt = 0; attempt < 5; attempt++)
        {
            try
            {
                Clipboard.SetText(text ?? "", TextDataFormat.UnicodeText);
                return;
            }
            catch
            {
                Thread.Sleep(120);
            }
        }
    }

    private static void TryClearClipboard()
    {
        for (int attempt = 0; attempt < 5; attempt++)
        {
            try
            {
                Clipboard.Clear();
                return;
            }
            catch
            {
                Thread.Sleep(120);
            }
        }
    }

    private static string ResolveDownloadDirectory(string downloadDirectory)
    {
        if (!String.IsNullOrWhiteSpace(downloadDirectory))
        {
            return Path.GetFullPath(downloadDirectory);
        }

        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            "Downloads"
        );
    }

    private static Dictionary<string, FileSnapshot> SnapshotFiles(string directory)
    {
        Directory.CreateDirectory(directory);
        var snapshots = new Dictionary<string, FileSnapshot>(StringComparer.OrdinalIgnoreCase);

        foreach (var file in Directory.GetFiles(directory))
        {
            var info = new FileInfo(file);
            snapshots[info.FullName] = new FileSnapshot {
                FullName = info.FullName,
                Name = info.Name,
                Length = info.Length,
                LastWriteTimeUtc = info.LastWriteTimeUtc
            };
        }

        return snapshots;
    }

    private static List<FileSnapshot> WaitForNewDownloads(string directory, Dictionary<string, FileSnapshot> before, int waitSeconds)
    {
        var deadline = DateTime.UtcNow.AddSeconds(Math.Max(1, waitSeconds));
        var result = new List<FileSnapshot>();

        while (DateTime.UtcNow < deadline)
        {
            bool hasPartial = Directory.GetFiles(directory, "*.crdownload").Length > 0;
            result = SnapshotFiles(directory)
                .Values
                .Where(file => IsNewOrChangedFile(file, before) && !file.Name.EndsWith(".crdownload", StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(file => file.LastWriteTimeUtc)
                .ToList();

            if (result.Count > 0 && !hasPartial)
            {
                return result;
            }

            Thread.Sleep(500);
        }

        return result;
    }

    private static bool IsNewOrChangedFile(FileSnapshot file, Dictionary<string, FileSnapshot> before)
    {
        FileSnapshot old;
        if (!before.TryGetValue(file.FullName, out old)) return true;
        return file.Length != old.Length || file.LastWriteTimeUtc != old.LastWriteTimeUtc;
    }

    private static string DownloadButtonsJson(List<DownloadButtonInfo> buttons)
    {
        var sb = new StringBuilder();
        sb.Append("[");
        for (int i = 0; i < buttons.Count; i++)
        {
            if (i > 0) sb.Append(",");
            var button = buttons[i];
            sb.Append("{");
            sb.Append("\"index\":").Append(button.Index).Append(",");
            sb.Append("\"name\":").Append(Json(button.Name)).Append(",");
            sb.Append("\"controlType\":").Append(Json(button.ControlType)).Append(",");
            sb.Append("\"canInvoke\":").Append(button.CanInvoke ? "true" : "false").Append(",");
            sb.Append("\"left\":").Append(JsonNumber(button.Left)).Append(",");
            sb.Append("\"top\":").Append(JsonNumber(button.Top)).Append(",");
            sb.Append("\"width\":").Append(JsonNumber(button.Width)).Append(",");
            sb.Append("\"height\":").Append(JsonNumber(button.Height));
            sb.Append("}");
        }
        sb.Append("]");
        return sb.ToString();
    }

    private static string CodeButtonsJson(List<CodeButtonInfo> buttons)
    {
        var sb = new StringBuilder();
        sb.Append("[");
        for (int i = 0; i < buttons.Count; i++)
        {
            if (i > 0) sb.Append(",");
            var button = buttons[i];
            sb.Append("{");
            sb.Append("\"index\":").Append(button.Index).Append(",");
            sb.Append("\"name\":").Append(Json(button.Name)).Append(",");
            sb.Append("\"left\":").Append(JsonNumber(button.Left)).Append(",");
            sb.Append("\"top\":").Append(JsonNumber(button.Top)).Append(",");
            sb.Append("\"width\":").Append(JsonNumber(button.Width)).Append(",");
            sb.Append("\"height\":").Append(JsonNumber(button.Height));
            sb.Append("}");
        }
        sb.Append("]");
        return sb.ToString();
    }

    private static string SimpleButtonsJson(List<SimpleButtonInfo> buttons)
    {
        var sb = new StringBuilder();
        sb.Append("[");
        for (int i = 0; i < buttons.Count; i++)
        {
            if (i > 0) sb.Append(",");
            var button = buttons[i];
            sb.Append("{");
            sb.Append("\"index\":").Append(button.Index).Append(",");
            sb.Append("\"name\":").Append(Json(button.Name)).Append(",");
            sb.Append("\"controlType\":").Append(Json(button.ControlType)).Append(",");
            sb.Append("\"canInvoke\":").Append(button.CanInvoke ? "true" : "false").Append(",");
            sb.Append("\"left\":").Append(JsonNumber(button.Left)).Append(",");
            sb.Append("\"top\":").Append(JsonNumber(button.Top)).Append(",");
            sb.Append("\"width\":").Append(JsonNumber(button.Width)).Append(",");
            sb.Append("\"height\":").Append(JsonNumber(button.Height));
            sb.Append("}");
        }
        sb.Append("]");
        return sb.ToString();
    }

    private static string AttachmentsJsonArray(List<AttachmentInfo> attachments)
    {
        var sb = new StringBuilder();
        sb.Append("[");
        for (int i = 0; i < attachments.Count; i++)
        {
            if (i > 0) sb.Append(",");
            var attachment = attachments[i];
            sb.Append("{");
            sb.Append("\"index\":").Append(attachment.Index).Append(",");
            sb.Append("\"name\":").Append(Json(attachment.Name)).Append(",");
            sb.Append("\"isUploading\":").Append(attachment.IsUploading ? "true" : "false").Append(",");
            sb.Append("\"hasRemoveButton\":").Append(attachment.RemoveElement == null ? "false" : "true").Append(",");
            sb.Append("\"removeButtonName\":").Append(Json(attachment.RemoveButtonName)).Append(",");
            sb.Append("\"left\":").Append(JsonNumber(attachment.Left)).Append(",");
            sb.Append("\"top\":").Append(JsonNumber(attachment.Top)).Append(",");
            sb.Append("\"width\":").Append(JsonNumber(attachment.Width)).Append(",");
            sb.Append("\"height\":").Append(JsonNumber(attachment.Height));
            sb.Append("}");
        }
        sb.Append("]");
        return sb.ToString();
    }

    private static string CodeBlocksJsonArray(List<CodeBlockInfo> blocks)
    {
        var sb = new StringBuilder();
        sb.Append("[");
        for (int i = 0; i < blocks.Count; i++)
        {
            if (i > 0) sb.Append(",");
            var block = blocks[i];
            sb.Append("{");
            sb.Append("\"index\":").Append(block.Index).Append(",");
            sb.Append("\"name\":").Append(Json(block.Name)).Append(",");
            sb.Append("\"hash\":").Append(Json(Sha256(NormalizeText(block.Text)))).Append(",");
            sb.Append("\"lineCount\":").Append(CountLines(block.Text)).Append(",");
            sb.Append("\"charCount\":").Append((block.Text ?? "").Length).Append(",");
            sb.Append("\"left\":").Append(JsonNumber(block.Left)).Append(",");
            sb.Append("\"top\":").Append(JsonNumber(block.Top)).Append(",");
            sb.Append("\"width\":").Append(JsonNumber(block.Width)).Append(",");
            sb.Append("\"height\":").Append(JsonNumber(block.Height)).Append(",");
            sb.Append("\"text\":").Append(Json(block.Text));
            sb.Append("}");
        }
        sb.Append("]");
        return sb.ToString();
    }

    private static string MessageInfoJson(MessageInfo message)
    {
        var sb = new StringBuilder();
        sb.Append("{");
        sb.Append("\"index\":").Append(message.Index).Append(",");
        sb.Append("\"role\":").Append(Json(message.Role)).Append(",");
        sb.Append("\"hash\":").Append(Json(Sha256(NormalizeText(message.Text)))).Append(",");
        sb.Append("\"lineCount\":").Append(CountLines(message.Text)).Append(",");
        sb.Append("\"charCount\":").Append((message.Text ?? "").Length).Append(",");
        sb.Append("\"left\":").Append(JsonNumber(message.Left)).Append(",");
        sb.Append("\"top\":").Append(JsonNumber(message.Top)).Append(",");
        sb.Append("\"width\":").Append(JsonNumber(message.Width)).Append(",");
        sb.Append("\"height\":").Append(JsonNumber(message.Height)).Append(",");
        sb.Append("\"text\":").Append(Json(message.Text));
        sb.Append("}");
        return sb.ToString();
    }

    private static int CountLines(string text)
    {
        if (String.IsNullOrEmpty(text)) return 0;
        return NormalizeText(text).Split('\n').Length;
    }

    private static string FilesJson(List<FileSnapshot> files)
    {
        var sb = new StringBuilder();
        sb.Append("[");
        for (int i = 0; i < files.Count; i++)
        {
            if (i > 0) sb.Append(",");
            var file = files[i];
            sb.Append("{");
            sb.Append("\"name\":").Append(Json(file.Name)).Append(",");
            sb.Append("\"fullName\":").Append(Json(file.FullName)).Append(",");
            sb.Append("\"length\":").Append(file.Length).Append(",");
            sb.Append("\"lastWriteTimeUtc\":").Append(Json(file.LastWriteTimeUtc.ToString("o")));
            sb.Append("}");
        }
        sb.Append("]");
        return sb.ToString();
    }

    private static string JsonNumber(double value)
    {
        if (Double.IsNaN(value) || Double.IsInfinity(value)) return "null";
        return value.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    private static string Sha256(string text)
    {
        using (var sha = SHA256.Create())
        {
            var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(text ?? ""));
            var sb = new StringBuilder(bytes.Length * 2);
            foreach (var b in bytes) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }
    }

    private static string Json(string value)
    {
        if (value == null) return "null";
        var sb = new StringBuilder();
        sb.Append('"');
        foreach (var c in value)
        {
            switch (c)
            {
                case '\\': sb.Append("\\\\"); break;
                case '"': sb.Append("\\\""); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    private sealed class TextItem
    {
        public int Index;
        public string ControlType;
        public string Name;
    }

    private sealed class PromptWriteResult
    {
        public string Method;
        public bool UsedClipboard;
        public bool Verified;
        public string ActualValue;
    }

    private sealed class DownloadButtonInfo
    {
        public int Index;
        public string Name;
        public string ControlType;
        public bool CanInvoke;
        public double Left;
        public double Top;
        public double Width;
        public double Height;
        public AutomationElement Element;
    }

    private sealed class CodeButtonInfo
    {
        public int Index;
        public string Name;
        public string ClassName;
        public double Left;
        public double Top;
        public double Width;
        public double Height;
        public AutomationElement Element;
    }

    private sealed class SimpleButtonInfo
    {
        public int Index;
        public string Name;
        public string ControlType;
        public bool CanInvoke;
        public double Left;
        public double Top;
        public double Width;
        public double Height;
        public AutomationElement Element;
    }

    private sealed class CodeBlockInfo
    {
        public int Index;
        public string Name;
        public double Left;
        public double Top;
        public double Width;
        public double Height;
        public string Text;
    }

    private sealed class MessageInfo
    {
        public int Index;
        public string Role;
        public string Text;
        public double Left;
        public double Top;
        public double Width;
        public double Height;
    }

    private sealed class AttachmentInfo
    {
        public int Index;
        public string Name;
        public bool IsUploading;
        public string RemoveButtonName;
        public double Left;
        public double Top;
        public double Width;
        public double Height;
        public AutomationElement RemoveElement;
    }

    private sealed class FileSnapshot
    {
        public string Name;
        public string FullName;
        public long Length;
        public DateTime LastWriteTimeUtc;
    }
}
"@

Add-Type -TypeDefinition $source -ReferencedAssemblies UIAutomationClient,UIAutomationTypes,System.Windows.Forms,System.Drawing,WindowsBase

try {
  switch ($Action) {
    "read" {
      [ChatGptUiaBridge]::ReadJson($WindowTitleContains, $MaxItems)
    }
    "downloads" {
      [ChatGptUiaBridge]::DownloadsJson($WindowTitleContains)
    }
    "attachments" {
      [ChatGptUiaBridge]::AttachmentsJson($WindowTitleContains)
    }
    "upload" {
      [ChatGptUiaBridge]::UploadFileJson($WindowTitleContains, $FilePath, $WaitForUploadSeconds)
    }
    "removeattachments" {
      [ChatGptUiaBridge]::RemoveAttachmentsJson($WindowTitleContains, $AttachmentNameContains, $MaxAttachments)
    }
    "state" {
      [ChatGptUiaBridge]::StateJson($WindowTitleContains)
    }
    "codeblocks" {
      [ChatGptUiaBridge]::CodeBlocksJson($WindowTitleContains, $MaxCodeBlocks, $CodeBlockOffsetFromLatest)
    }
    "lastresponse" {
      [ChatGptUiaBridge]::LastResponseJson($WindowTitleContains)
    }
    "stop" {
      [ChatGptUiaBridge]::StopGenerationJson($WindowTitleContains)
    }
    "send" {
      [ChatGptUiaBridge]::SendJson($WindowTitleContains, $Message, -not $NoSubmit.IsPresent, $AllowMismatch.IsPresent)
    }
    "download" {
      [ChatGptUiaBridge]::DownloadJson($WindowTitleContains, $DownloadNameContains, $DownloadDirectory, $WaitForDownloadSeconds, $MaxDownloads)
    }
  }
} catch {
  $errorMessage = $_.Exception.Message
  if ($_.Exception.InnerException -and $_.Exception.InnerException.Message) {
    $errorMessage = "$errorMessage InnerException: $($_.Exception.InnerException.Message)"
  }
  $errorResult = [ordered]@{
    ok = $false
    error = $errorMessage
  }
  $errorResult | ConvertTo-Json -Compress
  exit 1
}
