# Obsidian Reader MCP

只读 MCP 服务，用来让 AI 安全读取本地 Obsidian vault 内容。

## 功能

- `list_notes`: 浏览 vault 内的目录和笔记
- `read_note`: 读取单篇笔记内容
- `search_notes`: 在 Markdown / Canvas / 文本文件中搜索关键词
- `get_note_metadata`: 提取标题、frontmatter、标题层级、链接等元数据
- `find_backlinks`: 查找指向某篇笔记的反向链接

默认限制：

- 只能读取 `OBSIDIAN_VAULT_PATH` 指定目录内部的文件
- 默认不读取 `.obsidian` 配置目录
- 默认只读取常见文本文件扩展名
- 默认单文件最大读取 `1 MB`
- 不提供写入、删除、移动文件能力

### 解析说明（Node 版）

- **frontmatter**：使用标准 YAML 解析器，支持列表、多行、引号、嵌套映射。为保持输出稳定，非字符串标量（数字 / 布尔等）会被转为字符串，列表保持为数组，嵌套对象会序列化为 JSON 字符串。解析失败时回退为简单的 `key: value` 行解析，不会中断工具调用。
- **markdown 链接**：`[text](target)` 的 target 支持一层嵌套括号，能正确处理含括号的文件名（如 `[x](Path(1).md)`），不再在第一个 `)` 处截断。
- **启动日志**：日志只写入单一权威路径（`OBSIDIAN_READER_LOG_PATH` 或 `<projectRoot>/logs/kelivo-startup.log`），每条日志带 `pid`，便于区分多个进程（例如客户端能力探测进程与正式 npx 启动进程）的日志条目。

## npx 配置（推荐）

推荐用 STDIO + `npx` 启动。下面给出三种 npx 调用方式，**按推荐顺序排列**。

请先把示例里的占位符替换成你自己的路径：

- `F:\Path\To\Local_Reader`：本项目所在目录
- `F:\Path\To\Your\ObsidianVault`：你的 Obsidian vault 根目录

> 提示：可以先在终端里运行 `npx obsidian-reader-mcp --version` 验证调用链是否通畅。

### 方式一：本地源码目录（最稳定，无需打包）

直接用项目源码目录，不需要先生成 `.tgz`。`--package=.` 指向当前工作目录的 `package.json`。

**命令**

```text
npx
```

**参数**

```text
--yes --package=. -- obsidian-reader-mcp --vault F:\Path\To\Your\ObsidianVault
```

**工作目录**

```text
F:\Path\To\Local_Reader
```

也可以省略 `--vault`，在工作目录下放一个 `.env`：

```text
F:\Path\To\Local_Reader\.env
```

```text
OBSIDIAN_VAULT_PATH=F:\Path\To\Your\ObsidianVault
```

此时参数简化为：

```text
--yes --package=. -- obsidian-reader-mcp
```

### 方式二：tarball 包（适合分发固定版本）

先用 `npm pack` 生成 `obsidian-reader-mcp-0.1.1.tgz`，再指向它。版本固定、可离线分发，但 tgz 路径写死后不能移动。

**命令**

```text
npx
```

**参数**

```text
--yes --package=F:\Path\To\Local_Reader\obsidian-reader-mcp-0.1.1.tgz -- obsidian-reader-mcp --vault F:\Path\To\Your\ObsidianVault
```

**工作目录**

```text
F:\Path\To\Local_Reader
```

### 方式三：已发布到 npm（最简洁）

如果本包已发布到 npm registry，可省略 `--package`，npx 会自动拉取最新版：

**命令**

```text
npx
```

**参数**

```text
--yes obsidian-reader-mcp --vault F:\Path\To\Your\ObsidianVault
```

> 当前包未发布到 npm，请优先使用方式一。

### vault 路径的三种提供方式（优先级从高到低）

1. `--vault <path>` 命令行参数（最高优先级）
2. `OBSIDIAN_VAULT_PATH` 环境变量（客户端 env 配置）
3. 工作目录下的 `.env` 文件

如果你的 MCP 客户端支持环境变量，可直接在客户端 env 里填：

```text
OBSIDIAN_VAULT_PATH=F:\Path\To\Your\ObsidianVault
```

### 客户端兼容性兜底

如果某个客户端不能正确解析 `npx` 的多参数（部分 Windows 客户端对 `--package=X -- bin` 拼接支持不佳），可用 PowerShell 注入环境变量 + 本地目录方式：

**命令**

```text
pwsh
```

**参数**

```text
-NoProfile -Command "$env:OBSIDIAN_VAULT_PATH='F:\Path\To\Your\ObsidianVault'; npx --yes --package F:\Path\To\Local_Reader obsidian-reader-mcp"
```

**工作目录**

```text
F:\Path\To\Local_Reader
```

## 安装 Python 版

Python 版仍然保留，适合你想直接用 Python 运行时使用。

```powershell
cd F:\Path\To\Local_Reader
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -U pip
.\.venv\Scripts\python.exe -m pip install -e .
```

## 运行测试

```powershell
.\.venv\Scripts\python.exe -m pip install pytest
.\.venv\Scripts\python.exe -m pytest
```

Node 版测试：

```powershell
npm test
```

tarball / npx smoke 测试：

```powershell
npm pack
node scripts\smoke-npx.mjs
```

`scripts\smoke-npx.mjs` 默认会创建一个临时 vault 做连通性测试；如果你想用自己的 vault 测试，可先设置 `OBSIDIAN_VAULT_PATH`。

## 上传 Git 前检查

- 不要提交 `.env`，其中可能包含你的真实 vault 路径。
- 示例配置统一使用 `F:\Path\To\...` 占位符；上传前可用 `rg "你的真实路径"` 再扫一遍。
- 如果只是备份源码，不一定需要提交 `obsidian-reader-mcp-*.tgz`；需要固定版本离线分发时再保留 tarball。
- 推荐先运行 `npm test` 和 `node scripts\smoke-npx.mjs`，确认 npm 包入口和 MCP stdio 初始化正常。

## Python MCP 客户端配置

把下面的 `F:\Path\To\Your\ObsidianVault` 改成你的 Obsidian vault 根目录。

```json
{
  "mcpServers": {
    "obsidian-reader": {
      "command": "F:\\Path\\To\\Local_Reader\\.venv\\Scripts\\python.exe",
      "args": [
        "-m",
        "obsidian_reader_mcp.server"
      ],
      "env": {
        "OBSIDIAN_VAULT_PATH": "F:\\Path\\To\\Your\\ObsidianVault"
      }
    }
  }
}
```

可选环境变量：

```powershell
$env:OBSIDIAN_READER_INCLUDE_DOT_OBSIDIAN = "false"
$env:OBSIDIAN_READER_MAX_FILE_BYTES = "1048576"
```

## 本地手动启动

```powershell
$env:OBSIDIAN_VAULT_PATH = "F:\Path\To\Your\ObsidianVault"
.\.venv\Scripts\python.exe -m obsidian_reader_mcp.server
```

MCP 服务使用 stdio 通信，手动启动后看起来会等待输入，这是正常的。

## 性能说明（Node 版）

为了在大 vault 上保持快速响应，Node 版做了两层缓存（对工具行为无影响，只是更快）：

- **配置缓存**：`OBSIDIAN_VAULT_PATH` 等环境变量只在进程启动时解析一次，后续每次工具调用复用同一份 settings，不再重复 `stat` vault 目录。
- **内存文本索引**：进程启动时（`main()` 中）会异步遍历整个 vault，把所有可读文本文件内容读入内存。`search_notes` 和 `find_backlinks` 直接扫描内存索引，无需每次调用都全量读盘。

> 影响：首次连接会有一次性的索引构建耗时（取决于 vault 大小），之后搜索 / 反向链接查询从秒级降到毫秒级。由于索引在启动时构建，**进程运行期间新增 / 修改的文件不会自动反映到搜索结果中**——如需刷新，重启 MCP 服务即可。

索引构建使用 `fs.promises` 异步 I/O，不会阻塞 MCP stdio 事件循环。
