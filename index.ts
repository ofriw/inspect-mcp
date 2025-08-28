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
        description: 'Inspects the first DOM element matching a CSS selector and returns visual and style information',
        inputSchema: {
          type: 'object',
          properties: {
            css_selector: {
              type: 'string',
              description: 'CSS selector to find the element',
            },
            url: {
              type: 'string',
              description: 'URL of the page to inspect',
            },
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
      url: typedArgs.url as string
    };
    
    // Validate required arguments
    if (!inspectArgs.css_selector) {
      throw new Error('css_selector is required');
    }
    if (!inspectArgs.url) {
      throw new Error('url is required');
    }
    
    console.error(`Inspecting element: ${inspectArgs.css_selector}`);
    console.error(`Page URL: ${inspectArgs.url}`);
    
    const result = await inspectElement(inspectArgs);
    
    // Extract base64 data from data URL for image block
    const base64Data = result.screenshot.replace(/^data:image\/png;base64,/, '');
    
    // Create structured diagnostic data object
    const diagnosticData = {
      selector: inspectArgs.css_selector,
      url: inspectArgs.url,
      computed_styles: result.computed_styles,
      cascade_rules: result.cascade_rules,
      box_model: result.box_model
    };
    
    return {
      content: [
        {
          type: 'text',
          text: `Inspected element: ${inspectArgs.css_selector}`
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
    console.error('Received SIGINT, shutting down gracefully...');
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.error('Received SIGTERM, shutting down gracefully...');
    process.exit(0);
  });
  
  await server.connect(transport);
  console.error('CDP Inspector MCP server running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});