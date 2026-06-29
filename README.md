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

## 安装

```powershell
cd F:\A_Projects_pack_Classified\08_自编写MCP\Local_Reader
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -U pip
.\.venv\Scripts\python.exe -m pip install -e .
```

## 运行测试

```powershell
.\.venv\Scripts\python.exe -m pip install pytest
.\.venv\Scripts\python.exe -m pytest
```

## MCP 客户端配置

把下面的 `F:\Path\To\Your\ObsidianVault` 改成你的 Obsidian vault 根目录。

```json
{
  "mcpServers": {
    "obsidian-reader": {
      "command": "F:\\A_Projects_pack_Classified\\08_自编写MCP\\Local_Reader\\.venv\\Scripts\\python.exe",
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

