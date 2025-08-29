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
        description: 'Inspects the first DOM element matching a CSS selector and returns visual and style information. Response is optimized for LLM consumption with property grouping.',
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
            property_groups: {
              type: 'array',
              items: { type: 'string' },
              description: 'CSS property groups to include. Options: layout, box, flexbox, grid, typography, colors, visual, positioning, custom. Defaults to ["layout", "box", "typography", "colors"]',
            },
            include_all_properties: {
              type: 'boolean',
              description: 'Include all CSS properties without filtering. Defaults to false. When true, property_groups is ignored.',
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
      url: typedArgs.url as string,
      property_groups: typedArgs.property_groups as string[] | undefined,
      include_all_properties: typedArgs.include_all_properties as boolean | undefined
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
    
    // Create structured diagnostic data object
    const diagnosticData: any = {
      selector: inspectArgs.css_selector,
      url: inspectArgs.url,
      box_model: result.box_model
    };
    
    // Add grouped styles if available (more organized for LLMs)
    if (result.grouped_styles) {
      diagnosticData.grouped_styles = result.grouped_styles;
      diagnosticData.computed_styles_summary = {
        total_properties: result.stats?.total_properties || 0,
        filtered_properties: result.stats?.filtered_properties || 0,
        groups_requested: inspectArgs.property_groups || ['layout', 'box', 'typography', 'colors']
      };
    } else {
      diagnosticData.computed_styles = result.computed_styles;
    }
    
    // Add cascade rules (filtered)
    diagnosticData.cascade_rules = result.cascade_rules;
    if (result.stats) {
      diagnosticData.cascade_rules_summary = {
        total_rules: result.stats.total_rules,
        filtered_rules: result.stats.filtered_rules
      };
    }
    
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