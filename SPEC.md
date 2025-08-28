# MCP CDP Element Inspector - Minimal POC Spec

## Overview
An MCP stdio server that exposes a single tool for inspecting DOM elements via Chrome Developer Protocol (CDP). The server automatically discovers running Chrome/Chromium instances with debugging enabled, or launches its own Chrome instance if needed - ensuring zero-configuration operation.

## Server Configuration

### Transport
- **Type**: stdio (standard input/output)
- **Message Format**: JSON-RPC 2.0, newline-delimited
- **Protocol Version**: 2025-06-18

### Initialization
```json
{
  "name": "cdp-inspector",
  "version": "0.1.0",
  "capabilities": {
    "tools": {}
  }
}
```

## Tool Definition

### `inspect_element`
Inspects a DOM element using a CSS selector and returns visual and style information.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "css_selector": {
      "type": "string",
      "description": "CSS selector to find the element"
    },
    "target_title": {
      "type": "string",
      "description": "Optional: Browser tab title to target (uses active tab if not specified)"
    }
  },
  "required": ["css_selector"]
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "screenshot": {
      "type": "string",
      "description": "Base64-encoded PNG with element bounds, margins, padding overlays"
    },
    "computed_styles": {
      "type": "object",
      "description": "Final computed CSS properties as key-value pairs"
    },
    "cascade_rules": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "selector": { "type": "string" },
          "source": { "type": "string" },
          "specificity": { "type": "string" },
          "properties": { "type": "object" }
        }
      },
      "description": "CSS rules in cascade order that affect this element"
    },
    "box_model": {
      "type": "object",
      "properties": {
        "content": { "$ref": "#/definitions/rect" },
        "padding": { "$ref": "#/definitions/rect" },
        "border": { "$ref": "#/definitions/rect" },
        "margin": { "$ref": "#/definitions/rect" }
      }
    }
  }
}
```

## Auto-Discovery & Fallback Behavior

### Discovery Flow
1. **Check for existing CDP instance**: Scan ports 9222-9229 for Chrome with debugging enabled
2. **If none found, auto-launch**: Automatically launch a new Chrome instance with CDP enabled
3. **Connect and proceed**: Use the discovered or newly launched instance

### Port Scanning
The server scans ports 9222-9229 (common CDP ports) by checking `http://localhost:PORT/json/version`

### Auto-Launch Fallback
When no Chrome instance with CDP is found, automatically launch one:
```javascript
const chromeLauncher = require('chrome-launcher');

async function ensureChromeWithCDP() {
  // First, try to find existing Chrome with CDP
  const existing = await discoverBrowser();
  if (existing) return existing;

  // Launch new Chrome instance with debugging
  const chrome = await chromeLauncher.launch({
    port: 9222,
    chromeFlags: [
      '--window-size=1280,1024',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check'
    ],
    // Use temp directory for isolated profile (required for Chrome 136+)
    userDataDir: false // chrome-launcher handles temp dir creation
  });

  console.log(`Launched Chrome with CDP on port ${chrome.port}`);

  // Return connection info
  const targets = await fetch(`http://localhost:${chrome.port}/json`);
  return {
    port: chrome.port,
    targets: await targets.json(),
    kill: () => chrome.kill() // Cleanup function
  };
}
```

### Target Selection Logic
1. If `target_title` is provided: Find first page with matching title (partial match)
2. If no `target_title`: Use the first available page target
3. If multiple tabs exist and no match: Return helpful error with list of available tabs

### Discovery Response on Error
When multiple tabs are found but no target specified:
```json
{
  "error": {
    "code": -32603,
    "message": "Multiple tabs found. Please specify target_title",
    "data": {
      "available_tabs": [
        { "title": "GitHub - Repository", "url": "https://github.com/..." },
        { "title": "Stack Overflow - Question", "url": "https://stackoverflow.com/..." },
        { "title": "Google Search", "url": "https://google.com/..." }
      ]
    }
  }
}
```

## CDP Implementation Flow

### 1. Auto-Discovery & Connection
```javascript
// Auto-discover Chrome/Chromium instances with CDP enabled
async function discoverBrowser() {
  const ports = [9222, 9223, 9224, 9225, 9226, 9227, 9228, 9229];

  for (const port of ports) {
    try {
      // Check if CDP is available on this port
      const response = await fetch(`http://localhost:${port}/json/version`);
      if (response.ok) {
        const version = await response.json();
        console.log(`Found ${version.Browser} on port ${port}`);

        // Get list of available targets/tabs
        const targets = await fetch(`http://localhost:${port}/json`);
        return {
          port,
          version,
          targets: await targets.json()
        };
      }
    } catch (e) {
      // Port not available, continue scanning
    }
  }
  return null; // No existing Chrome with CDP found
}

// Ensure Chrome with CDP is available
async function ensureChromeWithCDP() {
  // First, try to find existing Chrome with CDP
  const existing = await discoverBrowser();
  if (existing) {
    console.log('Using existing Chrome instance');
    return existing;
  }

  // Launch new Chrome instance with debugging
  console.log('No Chrome with CDP found, launching new instance...');
  const chromeLauncher = require('chrome-launcher');
  const chrome = await chromeLauncher.launch({
    port: 9222,
    chromeFlags: [
      '--window-size=1280,1024',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check'
    ],
    userDataDir: false // Temp directory (required for Chrome 136+)
  });

  // Get targets from newly launched Chrome
  const targets = await fetch(`http://localhost:${chrome.port}/json`);
  return {
    port: chrome.port,
    targets: await targets.json(),
    chromeInstance: chrome // Keep reference for cleanup
  };
}

// Connect to specific target
async function connectToTarget(browser, target_title) {
  // Find target by title or use first page
  let target;
  if (target_title) {
    target = browser.targets.find(t =>
      t.type === 'page' && t.title.includes(target_title)
    );
  } else {
    // Use first available page target
    target = browser.targets.find(t => t.type === 'page');
  }

  if (!target) {
    // If we launched Chrome ourselves and no page exists, create one
    if (browser.chromeInstance && browser.targets.length === 0) {
      await fetch(`http://localhost:${browser.port}/json/new`);
      const updatedTargets = await fetch(`http://localhost:${browser.port}/json`);
      browser.targets = await updatedTargets.json();
      target = browser.targets[0];
    } else {
      throw new Error(`No target found${target_title ? ` matching "${target_title}"` : ''}`);
    }
  }

  // Connect via WebSocket
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  return ws;
}
```

### 2. Element Selection & Inspection
```javascript
// Enable required domains
await cdp.send('DOM.enable')
await cdp.send('CSS.enable')
await cdp.send('Page.enable')
await cdp.send('Overlay.enable')

// Find element
const doc = await cdp.send('DOM.getDocument')
const nodeId = await cdp.send('DOM.querySelector', {
  nodeId: doc.root.nodeId,
  selector: css_selector
})

if (!nodeId) {
  throw new Error(`Element not found: ${css_selector}`)
}

// Get box model for bounds
const boxModel = await cdp.send('DOM.getBoxModel', { nodeId })

// Get computed styles
const computedStyles = await cdp.send('CSS.getComputedStyleForNode', { nodeId })

// Get matching CSS rules (cascade)
const matchedStyles = await cdp.send('CSS.getMatchedStylesForNode', { nodeId })
```

### 3. Visual Annotation
```javascript
// Highlight element with overlay
await cdp.send('Overlay.highlightNode', {
  nodeId,
  highlightConfig: {
    contentColor: { r: 111, g: 168, b: 220, a: 0.3 },
    paddingColor: { r: 147, g: 196, b: 125, a: 0.3 },
    borderColor: { r: 255, g: 229, b: 153, a: 0.3 },
    marginColor: { r: 246, g: 178, b: 107, a: 0.3 },
    showInfo: true,
    showRulers: true,
    showExtensionLines: true
  }
})

// Capture screenshot with overlay
const screenshot = await cdp.send('Page.captureScreenshot', {
  format: 'png',
  clip: {
    x: boxModel.margin[0].x - 20,
    y: boxModel.margin[0].y - 20,
    width: boxModel.margin[2].x - boxModel.margin[0].x + 40,
    height: boxModel.margin[2].y - boxModel.margin[0].y + 40,
    scale: 1
  }
})

// Clear overlay
await cdp.send('Overlay.hideHighlight')
```

## Startup Requirements

### Automatic Browser Handling
The server handles Chrome/Chromium automatically:

1. **Best case**: User already has Chrome running with `--remote-debugging-port`
   ```bash
   chrome --remote-debugging-port=9222
   ```

2. **Fallback**: Server launches its own Chrome instance
   - Creates temporary user profile (required for Chrome 136+)
   - Opens in a separate window
   - Does not interfere with user's main Chrome session
   - Automatically cleaned up on server shutdown

### Server Launch
```bash
node cdp-inspector-server.js
```

No manual browser configuration required - the server handles everything.

## Error Handling

- **Chrome launch failure**: Return error if unable to launch Chrome (e.g., Chrome not installed)
- **Multiple tabs, no target specified**: Return list of available tabs with their titles
- **Target not found**: Return error with available tab titles
- **Element not found**: Return error with selector that failed
- **CDP command failure**: Forward CDP error message with context

## Dependencies

- **chrome-launcher**: Chrome detection and launching with CDP support
- **ws**: WebSocket client for CDP connection
- **@modelcontextprotocol/sdk**: MCP server implementation
- Standard Node.js libraries (fs, path)

## Example MCP Client Request

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

Or without specifying a target (uses active tab):
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "inspect_element",
    "arguments": {
      "css_selector": ".header-navigation"
    }
  },
  "id": 1
}
```

## Response Example

```json
{
  "jsonrpc": "2.0",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Element inspected successfully"
      }
    ],
    "screenshot": "data:image/png;base64,iVBORw0...",
    "computed_styles": {
      "display": "flex",
      "width": "1200px",
      "height": "80px",
      "background-color": "rgb(255, 255, 255)",
      ...
    },
    "cascade_rules": [
      {
        "selector": ".header-navigation",
        "source": "styles.css:45",
        "specificity": "0,1,0",
        "properties": { "display": "flex", "height": "80px" }
      },
      {
        "selector": "nav",
        "source": "base.css:12",
        "specificity": "0,0,1",
        "properties": { "background-color": "white" }
      }
    ],
    "box_model": {
      "content": { "x": 100, "y": 20, "width": 1200, "height": 80 },
      "padding": { "x": 90, "y": 10, "width": 1220, "height": 100 },
      "border": { "x": 90, "y": 10, "width": 1220, "height": 100 },
      "margin": { "x": 80, "y": 0, "width": 1240, "height": 120 }
    }
  },
  "id": 1
}
```

## Implementation Notes

1. **Zero-config operation**: Server automatically handles Chrome discovery or launching
2. **Chrome 136+ compatibility**: Uses temporary user-data-dir for security compliance
3. **Non-disruptive**: Launched Chrome instance is isolated from user's main browser
4. **Cleanup**: Server tracks launched Chrome instances and kills them on shutdown
5. **Performance**: Cache CDP connections between requests when using same browser
6. **Future enhancements**:
   - Browser preference settings (Chrome vs Edge vs Chromium)
   - Reuse launched browser across multiple requests
   - Support for connecting to remote Chrome instances
