#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { inspectElement } from './inspector.js';
import type { InspectElementArgs } from './types.js';

const server = new Server(
  {
    name: 'cdp-inspector',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'inspect_element',
        description: 'Inspects DOM elements on a webpage by taking a screenshot with highlighted elements and extracting computed CSS styles. Automatically finds all matching elements and calculates relationships when multiple elements match. Use for visual analysis, debugging styling issues, or validating layouts.',
        inputSchema: {
          type: 'object',
          properties: {
            css_selector: {
              type: 'string',
              description: 'CSS selector to find element(s). Examples: \'#submit-button\', \'.nav-item\', \'button\'. If multiple elements match, relationships between them will be calculated automatically.',
            },
            url: {
              type: 'string',
              description: 'Complete webpage URL to inspect. Must include protocol. Examples: \'https://example.com\', \'http://localhost:3000\'.',
            },
            property_groups: {
              type: 'array',
              items: { type: 'string' },
              description: 'Choose which categories of CSS properties to retrieve. Use this to focus on specific styling aspects:\n- layout: display, flex properties, grid properties\n- box: margin, padding, border, width, height\n- typography: font properties, text properties, line-height\n- colors: color, background-color, border-color\n- visual: opacity, visibility, transform, filter\n- positioning: position, top/left/right/bottom, z-index\nDefault: ["layout", "box", "typography", "colors"]',
            },
            css_edits: {
              type: 'object',
              description: 'Test CSS changes by applying styles before taking the screenshot. Provide as key-value pairs. Example: {\'background-color\': \'#ff0000\', \'padding\': \'20px\', \'display\': \'none\'}. The screenshot will show these changes applied.',
              additionalProperties: {
                type: 'string'
              }
            },
            limit: {
              type: 'number',
              description: 'Maximum number of elements to inspect when multiple elements match the selector. Defaults to 10.',
              minimum: 1,
              maximum: 20
            }
          },
          required: ['css_selector', 'url'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  if (name !== 'inspect_element') {
    throw new Error(`Unknown tool: ${name}`);
  }
  
  try {
    const typedArgs = args as Record<string, unknown>;
    
    // Validate and convert arguments
    const inspectArgs: InspectElementArgs = {
      css_selector: typedArgs.css_selector as string,
      url: typedArgs.url as string,
      property_groups: typedArgs.property_groups as string[] | undefined,
      css_edits: typedArgs.css_edits as Record<string, string> | undefined,
      limit: typedArgs.limit as number | undefined
    };
    
    // Validate required arguments
    if (!inspectArgs.css_selector) {
      throw new Error('css_selector is required');
    }
    if (!inspectArgs.url) {
      throw new Error('url is required');
    }
    
    const result = await inspectElement(inspectArgs);
    
    // Extract base64 data from data URL for image block
    const base64Data = result.screenshot.replace(/^data:image\/png;base64,/, '');
    
    // Check if this is a multi-element result
    const isMultiElement = 'elements' in result;
    
    // Create minimal diagnostic data (no empty arrays/objects)
    const diagnosticData: any = { ...result };
    delete diagnosticData.screenshot; // Don't duplicate in diagnostic
    
    const elementText = isMultiElement 
      ? `Inspected ${result.elements.length} elements: ${inspectArgs.css_selector}`
      : `Inspected element: ${inspectArgs.css_selector}`;
    
    return {
      content: [
        {
          type: 'text',
          text: elementText
        },
        {
          type: 'image',
          data: base64Data,
          mimeType: 'image/png'
        },
        {
          type: 'text',
          text: JSON.stringify(diagnosticData, null, 2)
        }
      ]
    };
    
  } catch (error) {
    console.error('Inspection error:', error);
    
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  
  // Handle cleanup on exit
  process.on('SIGINT', () => {
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    process.exit(0);
  });
  
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});