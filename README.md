# CDP Inspector

MCP server for DOM element inspection via Chrome DevTools Protocol.

## Features

- **Zero-config**: Auto-discovers Chrome with debugging or launches new instance
- **Visual inspection**: Screenshots with element bounds, margins, padding overlays  
- **Style analysis**: Computed styles and CSS cascade rules
- **Box model**: Complete layout information

## Usage

### Build & Run
```bash
npm install
npm run build
npm start
```

### Chrome Display Mode

By default, Chrome runs with a **visible window** for debugging. To control this:

**Visible Chrome (default):**
```bash
npm start
```

**Headless Chrome (no window):**
```bash
HEADLESS=true npm start
```

You can also create a `.env` file (copy from `.env.example`) to set this permanently.

### MCP Client Configuration

Add to your MCP client config (e.g., Claude Desktop):

```json
{
  "mcpServers": {
    "cdp-inspector": {
      "command": "node",
      "args": ["/absolute/path/to/inspect-mcp/dist/index.js"],
      "transport": "stdio"
    }
  }
}
```

### Tool: `inspect_element`

**Input:**
- `css_selector` (required): CSS selector to find element (returns first match)
- `target_title` (optional): Browser tab title to target

**Output:**
- `screenshot`: Base64 PNG with element overlays
- `computed_styles`: Final CSS properties
- `cascade_rules`: CSS rules affecting element (cascade order)
- `box_model`: Content, padding, border, margin rectangles

## Chrome Setup

**Recommended**: Run Chrome with debugging enabled:
```bash
chrome --remote-debugging-port=9222
```

**Fallback**: Server auto-launches Chrome if none found with CDP enabled.

## Example

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "inspect_element",
    "arguments": {
      "css_selector": ".header-navigation",
      "target_title": "GitHub"
    }
  },
  "id": 1
}
```

## Dependencies

- `@modelcontextprotocol/sdk`: MCP protocol implementation
- `chrome-launcher`: Chrome detection and launching  
- `ws`: WebSocket client for CDP communication

## Requirements

- Node.js 18+
- Chrome/Chromium browser