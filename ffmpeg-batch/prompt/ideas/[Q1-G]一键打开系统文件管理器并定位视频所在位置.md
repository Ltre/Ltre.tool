# Q1-G｜系统文件管理器定位输出文件——开发方案

> 状态：技术研究，未实施；适用于 `ffmpeg-batch/`（Node.js 后端 + HTML 前端）。

## 1. 目标与功能边界

在**已完成转码**的视频详情增加「定位输出文件」按钮。点击后，调用**运行 Node.js 的设备**上的系统文件管理器，打开输出文件所在目录，尽可能**选中目标文件并将窗口切至前台**。若平台不支持选中，则明确提示并降级为打开所在目录。

浏览器与 Node.js 分属不同设备时，本操作仍发生在**服务端设备**，不能打开另一台设备本地的文件管理器。只支持已登记、已完成且实际存在的输出视频。

## 2. 跨平台实现

| 平台 | 优先实现 | 降级与限制 |
|---|---|---|
| **Windows** | `explorer.exe /select, "C:\\path\\video.mp4"`；有需要可改用 Win32 `SHOpenFolderAndSelectItems` | Explorer 通常能选中文件；切前台受 Windows 焦点策略限制 |
| **macOS** | `open -R "/path/video.mp4"`，或原生 `NSWorkspace.activateFileViewerSelecting(_:)` | Finder 支持选中文件；不应保证强制抢占焦点 |
| **Linux 桌面** | D-Bus `org.freedesktop.FileManager1.ShowItems([fileURI], "")` | 不支持时 `xdg-open` 打开**父目录**；Wayland、不同文件管理器及无图形会话可能限制选中/置前 |
| **Android + Termux** | 优先尝试 Samsung My Files 私有 Intent；fooView 作为待验证适配器 | Android 无通用的“外部管理器高亮选中文件”接口；失败时降级为目录定位或工具内定位 |

Linux 使用 `pathToFileURL(path).href` 生成正确编码的文件 URI；不能自行拼接路径。Android 的 Node.js 也通常报告 `process.platform === 'linux'`，需先识别 **Termux/Android**，避免误走桌面 D-Bus 逻辑。

## 3. Android：Termux 实机验证

适用文件位置：优先使用 `/storage/emulated/0/...` 等共享存储；Termux 私有目录通常不能被外部文件管理器访问。以下命令仅为**待验证方案**，不是已实测保证。

**（1）检查包名与入口**

```sh
pm list packages | grep -E 'com.sec.android.app.myfiles|com.fooview.android.fooview'
cmd package resolve-activity --brief -a android.intent.action.MAIN \
  -c android.intent.category.LAUNCHER -p com.sec.android.app.myfiles
```

**（2）尝试 Samsung My Files 定位目录**

```sh
DIR='/storage/emulated/0/Movies_h265'
ACTIVITY=$(cmd package resolve-activity --brief \
  -a android.intent.action.MAIN \
  -c android.intent.category.LAUNCHER \
  -p com.sec.android.app.myfiles | tail -n 1)
am start -n "$ACTIVITY" \
  -a samsung.myfiles.intent.action.LAUNCH_MY_FILES \
  --es samsung.myfiles.intent.extra.START_PATH "$DIR"
```

这是历史版本的**非公开接口**，不同 One UI / My Files 版本可能忽略路径参数或拒绝调用；成功打开目录**不代表选中了文件**。

**（3）尝试 fooView 目录 Intent**

```sh
am start 'intent:/storage/emulated/0/Movies_h265/#Intent;type=resource/folder;end'
```

社区曾提到该方式可能需要 Root，普通 Termux 能否使用尚不确定。fooView 与独立 FV 文件浏览器不可混为同一应用。应分别记录：能否启动、是否进入目标目录、是否选中文件、浏览器前台触发时能否弹出；Android 10+ 还有后台启动 Activity 限制。

## 4. 接口与安全约束

建议新增本地接口：

```http
POST /api/files/reveal
Content-Type: application/json

{"sessionId":"任务ID","taskId":"视频ID","side":"output"}
```

后端实施要点：

1. **只接受 ID，不接受客户端传入的绝对路径或可执行命令**；从对应会话状态读取 `output`。
2. 校验视频 `status === 'done'`、文件存在且为普通文件，并用真实路径校验其位于对应孪生输出根目录内，防止路径穿越/符号链接越界。
3. 使用 `child_process.spawn()` 的**独立参数数组**，不通过 shell 拼接路径；限制本地请求来源并遵循现有接口安全策略。
4. 按 `Windows → macOS → Android/Termux → Linux 桌面` 选择适配器，处理缺少 GUI、命令不可用、路径不可见、Intent 被拒绝等情况。
5. 返回「已提交定位请求 / 已降级打开目录 / 调用失败」等可核实状态；**不要仅凭进程成功启动就宣称文件已被选中或窗口已获焦点**。

参考封装语义：Electron `shell.showItemInFolder(fullPath)`；本项目不必因此引入 Electron。

## 5. 验收范围

- Windows/macOS：文件管理器进入正确目录并选中目标文件；检查空格、中文文件名。
- Linux：验证至少一种支持 `FileManager1` 的文件管理器，以及 D-Bus 不可用时的目录降级；无桌面会话明确报错。
- Android：分别在 Samsung My Files、fooView 上实测；将**目录定位**与**文件高亮选中**分开判定，不承诺所有版本一致。
- 安全：未完成文件、文件缺失、伪造 ID、越界软链接不可触发文件管理器；网页客户端与服务端不在同一设备时提示操作发生位置。

## 6. 参考与讨论

- [Windows：SHOpenFolderAndSelectItems](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shopenfolderandselectitems)
- [Apple：NSWorkspace.activateFileViewerSelecting](https://developer.apple.com/documentation/appkit/nsworkspace/activatefileviewerselecting(_:))
- [Linux：FileManager1 D-Bus 接口](https://www.freedesktop.org/wiki/Specifications/file-manager-interface/)
- [Android：DocumentsContract.EXTRA_INITIAL_URI](https://developer.android.com/reference/android/provider/DocumentsContract#EXTRA_INITIAL_URI)
- [Electron：shell.showItemInFolder](https://www.electronjs.org/docs/latest/api/shell#shellshowiteminfolderfullpath)
- [fooView 目录 Intent 社区讨论](https://meta.appinn.net/t/topic/36508)

**本方案仅完成技术整理，尚未运行终端验证或修改代码。**
