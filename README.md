# Inspect MCP

MCP server for DOM element inspection via Chrome DevTools Protocol.

## Features

- **Zero-config**: Auto-discovers Chrome with debugging or launches new instance
- **Visual inspection**: Screenshots with element bounds, margins, padding overlays  
- **Style analysis**: Computed styles and CSS cascade rules
- **Box model**: Complete layout information
- **Multi-element inspection**: Automatically finds all matching elements and calculates relationships
- **Spatial measurements**: Distance and alignment calculations when multiple elements found

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
    "inspect-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/inspect-mcp/dist/index.js"],
      "transport": "stdio"
    }
  }
}
```

### Tool: `inspect_element`

**Input:**
- `css_selector` (required): CSS selector to find element(s). If multiple elements match, relationships are calculated automatically
- `url` (required): URL to navigate to and inspect  
- `property_groups` (optional): Array of CSS property groups to include ('layout', 'box', 'typography', 'colors', etc.)
- `css_edits` (optional): CSS properties to apply before inspection
- `limit` (optional): Maximum elements to inspect when multiple match (default: 10, max: 20)

**Single Element Output:**
- `screenshot`: Base64 PNG with element overlay
- `computed_styles`: Final CSS properties
- `cascade_rules`: CSS rules affecting element (cascade order)
- `box_model`: Content, padding, border, margin rectangles

**Multi-Element Output:**
- `screenshot`: Base64 PNG with all elements highlighted in different colors
- `elements`: Array of element inspection data (styles, box model, cascade rules)
- `relationships`: Pairwise distance and alignment calculations between elements

## Chrome Setup

**Recommended**: Run Chrome with debugging enabled:
```bash
chrome --remote-debugging-port=9222
```

**Fallback**: Server auto-launches Chrome if none found with CDP enabled.

## Examples

### Single Element Inspection
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "inspect_element",
    "arguments": {
      "css_selector": ".header-navigation",
      "url": "https://github.com"
    }
  },
  "id": 1
}
```

### Multi-Element Inspection with Relationships
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "inspect_element",
    "arguments": {
      "css_selector": "button",
      "url": "https://github.com",
      "property_groups": ["layout", "colors"],
      "limit": 3
    }
  },
  "id": 2
}
```

When multiple elements match, response includes relationships:
```json
{
  "elements": [/* array of element inspections */],
  "relationships": [{
    "from": "button[0]",
    "to": "button[1]", 
    "distance": {
      "horizontal": 12,
      "vertical": 0,
      "center_to_center": 85
    },
    "alignment": {
      "top": true,
      "vertical_center": true
    }
  }],
  "screenshot": "data:image/png;base64,..."
}
```

## Dependencies

- `@modelcontextprotocol/sdk`: MCP protocol implementation
- `chrome-launcher`: Chrome detection and launching  
- `ws`: WebSocket client for CDP communication

## Requirements

- Node.js 18+
- Chrome/Chromium browser