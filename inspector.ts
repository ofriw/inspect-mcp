import type { InspectElementArgs, InspectionResult, MultiInspectionResult, ElementInspection, ElementRelationship, BoxModel, CascadeRule, GroupedStyles } from './types.js';
import { ensureChromeWithCDP, connectToTarget, CDPClient } from './cdp-client.js';
import { 
  DEFAULT_PROPERTY_GROUPS, 
  shouldIncludeProperty, 
  categorizeProperties, 
  type PropertyGroup 
} from './property-groups.js';

// Visual constants for multi-element highlighting
const HIGHLIGHT_COLORS = [
  { r: 111, g: 168, b: 220, a: 0.3 }, // Blue
  { r: 147, g: 196, b: 125, a: 0.3 }, // Green
  { r: 255, g: 229, b: 153, a: 0.3 }, // Yellow
  { r: 246, g: 178, b: 107, a: 0.3 }, // Orange
  { r: 220, g: 111, b: 168, a: 0.3 }, // Purple
];

// Pixel tolerance for alignment detection
const ALIGNMENT_TOLERANCE = 1;

async function highlightElements(cdp: CDPClient, nodeIds: number[]): Promise<void> {
  for (let i = 0; i < nodeIds.length; i++) {
    const colorIndex = i % HIGHLIGHT_COLORS.length;
    await cdp.send('Overlay.highlightNode', {
      nodeId: nodeIds[i],
      highlightConfig: {
        contentColor: HIGHLIGHT_COLORS[colorIndex],
        paddingColor: HIGHLIGHT_COLORS[(colorIndex + 1) % HIGHLIGHT_COLORS.length],
        borderColor: HIGHLIGHT_COLORS[(colorIndex + 2) % HIGHLIGHT_COLORS.length],
        marginColor: HIGHLIGHT_COLORS[(colorIndex + 3) % HIGHLIGHT_COLORS.length],
        showInfo: true,
        showRulers: i === 0, // Only show rulers on first element to avoid clutter
        showExtensionLines: true
      }
    });
  }
}

/**
 * Inspects DOM elements on a webpage, automatically detecting single vs multiple elements.
 * Provides spatial relationship analysis for multiple elements - essential for AI agents
 * building pixel-perfect frontends. Uses temporary DOM attributes for element identification
 * to handle dynamic content and complex selectors.
 * 
 * @param args - Inspection parameters including selector, URL, property groups, and limits
 * @returns Single element result or multi-element result with spatial relationships
 */
export async function inspectElement(args: InspectElementArgs): Promise<InspectionResult | MultiInspectionResult> {
  const { 
    css_selector, 
    url, 
    property_groups = DEFAULT_PROPERTY_GROUPS,
    css_edits,
    limit = 10
  } = args;
  
  // Get or launch Chrome instance
  const browser = await ensureChromeWithCDP();
  
  // Connect to target
  const ws = await connectToTarget(browser, url);
  const cdp = new CDPClient(ws);
  
  try {
    // These domains should already be enabled during navigation
    // But enable them again in case we're reusing a tab
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    await cdp.send('Page.enable');
    await cdp.send('Overlay.enable');
    
    // Get document with retry logic
    let doc;
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
      try {
        doc = await cdp.send('DOM.getDocument');
        if (doc && doc.root && doc.root.nodeId) {
          break;
        } else {
          throw new Error('Document root is empty or invalid');
        }
      } catch (error) {
        attempts++;
        if (attempts >= maxAttempts) {
          throw new Error(`Failed to get document after ${maxAttempts} attempts: ${error}`);
        }
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, 500 * attempts));
      }
    }

    // Find all matching elements using Runtime.evaluate
    // Note: We use temporary data-inspect-id attributes to handle complex selectors
    // and ensure we get the exact same elements when querying for node IDs
    const evalResult = await cdp.send('Runtime.evaluate', {
      expression: `
        (function() {
          try {
            const elements = Array.from(document.querySelectorAll(${JSON.stringify(css_selector)}));
            if (elements.length === 0) return { error: 'No elements found' };
            
            // Mark elements with unique attributes and return info
            return elements.slice(0, ${limit}).map((el, i) => {
              const uniqueId = '_inspect_' + Date.now() + '_' + i;
              el.setAttribute('data-inspect-id', uniqueId);
              return {
                index: i,
                uniqueId: uniqueId,
                tagName: el.tagName,
                id: el.id || null,
                className: el.className || null
              };
            });
          } catch (e) {
            return { error: e.message };
          }
        })()
      `,
      returnByValue: true
    });
    
    if (evalResult.exceptionDetails) {
      throw new Error(`Invalid CSS selector: ${css_selector}`);
    }
    
    const result = evalResult.result.value;
    if (result.error) {
      throw new Error(`Element not found: ${css_selector}`);
    }
    
    // Get node IDs for each marked element
    const nodeIds: number[] = [];
    for (const elementInfo of result) {
      const nodeResult = await cdp.send('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: `[data-inspect-id="${elementInfo.uniqueId}"]`
      });
      
      if (nodeResult.nodeId) {
        nodeIds.push(nodeResult.nodeId);
      }
    }
    
    if (nodeIds.length === 0) {
      throw new Error(`Element not found: ${css_selector}`);
    }
    
    // Clean up the temporary attributes
    await cdp.send('Runtime.evaluate', {
      expression: `
        document.querySelectorAll('[data-inspect-id]').forEach(el => {
          el.removeAttribute('data-inspect-id');
        });
      `
    });
    
    if (nodeIds.length === 1) {
      // Single element - return simple structure
      return await inspectSingleElement(
        css_selector,
        nodeIds[0], 
        cdp, 
        property_groups as PropertyGroup[], 
        css_edits
      );
    } else {
      // Multiple elements - return with relationships
      return await inspectMultipleElements(
        css_selector,
        nodeIds, 
        cdp, 
        property_groups as PropertyGroup[], 
        css_edits
      );
    }
    
  } finally {
    cdp.close();
  }
}

async function inspectSingleElement(
  selector: string,
  nodeId: number,
  cdp: CDPClient,
  property_groups: PropertyGroup[],
  css_edits?: Record<string, string>
): Promise<InspectionResult> {
  
  // Apply CSS edits if provided
  if (css_edits && Object.keys(css_edits).length > 0) {
    await cdp.setInlineStyles(nodeId, css_edits);
  }
  
  // Get box model for bounds
  const boxModelResult = await cdp.send('DOM.getBoxModel', { nodeId });
  if (!boxModelResult.model) {
    throw new Error(`Unable to get box model for element: ${selector}. Element may not be visible.`);
  }
  const boxModel = convertBoxModel(boxModelResult.model);
  
  // Get computed styles
  const computedStylesResult = await cdp.send('CSS.getComputedStyleForNode', { nodeId });
  const allComputedStyles = convertComputedStyles(computedStylesResult.computedStyle);
  const filteredComputedStyles = filterComputedStyles(allComputedStyles, property_groups, false);
  
  // Get matching CSS rules (cascade)
  const matchedStylesResult = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
  const allCascadeRules = convertCascadeRules(matchedStylesResult);
  const filteredCascadeRules = filterCascadeRules(allCascadeRules, property_groups, false);
  
  // Highlight element with overlay
  await highlightElements(cdp, [nodeId]);
  
  // Capture full viewport screenshot with overlay
  const screenshotResult = await cdp.send('Page.captureScreenshot', {
    format: 'png'
  });
  
  if (!screenshotResult.data) {
    throw new Error('Failed to capture screenshot. The page may not be loaded or visible.');
  }
  
  // Clear overlay
  await cdp.send('Overlay.hideHighlight');
  
  // Create grouped styles
  const groupedStyles = categorizeProperties(filteredComputedStyles);
  
  // Create stats
  const stats = {
    total_properties: Object.keys(allComputedStyles).length,
    filtered_properties: Object.keys(filteredComputedStyles).length,
    total_rules: allCascadeRules.length,
    filtered_rules: filteredCascadeRules.length
  };
  
  return {
    screenshot: `data:image/png;base64,${screenshotResult.data}`,
    computed_styles: filteredComputedStyles,
    grouped_styles: groupedStyles,
    cascade_rules: filteredCascadeRules,
    box_model: boxModel,
    applied_edits: css_edits && Object.keys(css_edits).length > 0 ? css_edits : undefined,
    stats
  };
}

async function inspectMultipleElements(
  selector: string,
  nodeIds: number[],
  cdp: CDPClient,
  property_groups: PropertyGroup[],
  css_edits?: Record<string, string>
): Promise<MultiInspectionResult> {
  const elements: ElementInspection[] = [];
  const nodeData: Array<{ selector: string, nodeId: number, boxModel: BoxModel }> = [];
  
  let totalProperties = 0;
  let filteredProperties = 0;
  let totalRules = 0;
  let filteredRules = 0;
  
  // Process each element
  for (let i = 0; i < nodeIds.length; i++) {
    const nodeId = nodeIds[i];
    
    // Apply CSS edits if provided
    if (css_edits && Object.keys(css_edits).length > 0) {
      await cdp.setInlineStyles(nodeId, css_edits);
    }
    
    // Get box model for bounds
    const boxModelResult = await cdp.send('DOM.getBoxModel', { nodeId });
    if (!boxModelResult.model) {
      throw new Error(`Unable to get box model for element ${i + 1} of ${nodeIds.length}: ${selector}. Element may not be visible.`);
    }
    const boxModel = convertBoxModel(boxModelResult.model);
    
    // Store for distance calculations (already done above)
    
    // Get computed styles
    const computedStylesResult = await cdp.send('CSS.getComputedStyleForNode', { nodeId });
    const allComputedStyles = convertComputedStyles(computedStylesResult.computedStyle);
    const filteredComputedStyles = filterComputedStyles(allComputedStyles, property_groups, false);
    
    // Get matching CSS rules (cascade)
    const matchedStylesResult = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
    const allCascadeRules = convertCascadeRules(matchedStylesResult);
    const filteredCascadeRules = filterCascadeRules(allCascadeRules, property_groups, false);
    
    // Create grouped styles
    const groupedStyles = categorizeProperties(filteredComputedStyles);
    
    // Add to elements array
    elements.push({
      selector: `${selector}[${i}]`, // Add index for clarity
      computed_styles: filteredComputedStyles,
      grouped_styles: groupedStyles,
      cascade_rules: filteredCascadeRules,
      box_model: boxModel,
      applied_edits: css_edits && Object.keys(css_edits).length > 0 ? css_edits : undefined
    });
    
    // Store for distance calculations
    nodeData.push({ selector: `${selector}[${i}]`, nodeId, boxModel });
    
    // Accumulate stats
    totalProperties += Object.keys(allComputedStyles).length;
    filteredProperties += Object.keys(filteredComputedStyles).length;
    totalRules += allCascadeRules.length;
    filteredRules += filteredCascadeRules.length;
  }
  
  // Highlight all elements with different colors
  await highlightElements(cdp, nodeIds);
  
  // Capture screenshot with all overlays
  const screenshotResult = await cdp.send('Page.captureScreenshot', {
    format: 'png'
  });
  
  if (!screenshotResult.data) {
    throw new Error('Failed to capture screenshot. The page may not be loaded or visible.');
  }
  
  // Clear all overlays
  await cdp.send('Overlay.hideHighlight');
  
  // Calculate relationships between elements
  const relationships = calculateElementRelationships(nodeData);
  
  const result: MultiInspectionResult = {
    elements,
    relationships,
    screenshot: `data:image/png;base64,${screenshotResult.data}`,
    stats: {
      total_properties: totalProperties,
      filtered_properties: filteredProperties,
      total_rules: totalRules,
      filtered_rules: filteredRules
    }
  };
  
  return result;
}

/**
 * Calculates spatial relationships between multiple DOM elements.
 * Essential for AI agents to understand layout patterns and apply consistent spacing.
 * Uses O(n²) pairwise comparison - acceptable given element limits (max 20, default 10).
 * 
 * @param nodeData - Array of elements with selectors, node IDs, and box models
 * @returns Array of pairwise relationships with distances and alignment data
 */
function calculateElementRelationships(
  nodeData: Array<{ selector: string, nodeId: number, boxModel: BoxModel }>
): ElementRelationship[] {
  const relationships: ElementRelationship[] = [];
  
  // Calculate relationships between each pair of elements
  for (let i = 0; i < nodeData.length; i++) {
    for (let j = i + 1; j < nodeData.length; j++) {
      const element1 = nodeData[i];
      const element2 = nodeData[j];
      
      const relationship = calculatePairwiseRelationship(element1, element2);
      relationships.push(relationship);
    }
  }
  
  return relationships;
}

function calculatePairwiseRelationship(
  element1: { selector: string, nodeId: number, boxModel: BoxModel },
  element2: { selector: string, nodeId: number, boxModel: BoxModel }
): ElementRelationship {
  const box1 = element1.boxModel.border; // Use border box for measurements
  const box2 = element2.boxModel.border;
  
  // Calculate element centers
  const center1 = {
    x: box1.x + box1.width / 2,
    y: box1.y + box1.height / 2
  };
  const center2 = {
    x: box2.x + box2.width / 2,
    y: box2.y + box2.height / 2
  };
  
  // Calculate distances
  const centerToCenterDistance = Math.sqrt(
    Math.pow(center2.x - center1.x, 2) + Math.pow(center2.y - center1.y, 2)
  );
  
  // Calculate edge-to-edge distances (most useful for spacing)
  let horizontalDistance = 0;
  let verticalDistance = 0;
  
  // Horizontal distance (gaps between left/right edges)
  if (box1.x + box1.width < box2.x) {
    // Element 1 is to the left of element 2
    horizontalDistance = box2.x - (box1.x + box1.width);
  } else if (box2.x + box2.width < box1.x) {
    // Element 2 is to the left of element 1
    horizontalDistance = box1.x - (box2.x + box2.width);
  } else {
    // Elements overlap horizontally
    horizontalDistance = 0;
  }
  
  // Vertical distance (gaps between top/bottom edges)
  if (box1.y + box1.height < box2.y) {
    // Element 1 is above element 2
    verticalDistance = box2.y - (box1.y + box1.height);
  } else if (box2.y + box2.height < box1.y) {
    // Element 2 is above element 1
    verticalDistance = box1.y - (box2.y + box2.height);
  } else {
    // Elements overlap vertically
    verticalDistance = 0;
  }
  
  // Calculate alignment (with tolerance for "close enough")
  const tolerance = ALIGNMENT_TOLERANCE;
  const alignment = {
    top: Math.abs(box1.y - box2.y) <= tolerance,
    bottom: Math.abs((box1.y + box1.height) - (box2.y + box2.height)) <= tolerance,
    left: Math.abs(box1.x - box2.x) <= tolerance,
    right: Math.abs((box1.x + box1.width) - (box2.x + box2.width)) <= tolerance,
    vertical_center: Math.abs(center1.y - center2.y) <= tolerance,
    horizontal_center: Math.abs(center1.x - center2.x) <= tolerance
  };
  
  return {
    from: element1.selector,
    to: element2.selector,
    distance: {
      horizontal: Math.round(horizontalDistance),
      vertical: Math.round(verticalDistance),
      center_to_center: Math.round(centerToCenterDistance)
    },
    alignment
  };
}

function convertBoxModel(cdpBoxModel: any): BoxModel {
  // CDP returns box model as arrays of 8 numbers [x1, y1, x2, y2, x3, y3, x4, y4]
  // We convert to simple rect format
  const contentQuad = cdpBoxModel.content;
  const paddingQuad = cdpBoxModel.padding;
  const borderQuad = cdpBoxModel.border;
  const marginQuad = cdpBoxModel.margin;
  
  return {
    content: quadToRect(contentQuad),
    padding: quadToRect(paddingQuad),
    border: quadToRect(borderQuad),
    margin: quadToRect(marginQuad)
  };
}

function quadToRect(quad: number[]) {
  // Convert quad [x1, y1, x2, y2, x3, y3, x4, y4] to rect
  const x = Math.min(quad[0], quad[2], quad[4], quad[6]);
  const y = Math.min(quad[1], quad[3], quad[5], quad[7]);
  const maxX = Math.max(quad[0], quad[2], quad[4], quad[6]);
  const maxY = Math.max(quad[1], quad[3], quad[5], quad[7]);
  
  return {
    x,
    y,
    width: maxX - x,
    height: maxY - y
  };
}

function convertComputedStyles(cdpComputedStyle: any[]): Record<string, string> {
  const styles: Record<string, string> = {};
  
  for (const style of cdpComputedStyle) {
    styles[style.name] = style.value;
  }
  
  return styles;
}

function convertCascadeRules(cdpMatchedStyles: any): CascadeRule[] {
  const rules: CascadeRule[] = [];
  
  // Process matched CSS rules
  if (cdpMatchedStyles.matchedCSSRules) {
    for (const rule of cdpMatchedStyles.matchedCSSRules) {
      if (rule.rule && rule.rule.style) {
        const properties: Record<string, string> = {};
        
        for (const property of rule.rule.style.cssProperties) {
          if (property.name && property.value) {
            properties[property.name] = property.value;
          }
        }
        
        rules.push({
          selector: rule.rule.selectorList?.selectors?.map((s: any) => s.text).join(', ') || 'unknown',
          source: rule.rule.origin === 'user-agent' ? 'user-agent' : 
                  rule.rule.styleSheetId ? `stylesheet:${rule.rule.styleSheetId}` : 'inline',
          specificity: calculateSpecificity(rule.rule.selectorList?.selectors?.[0]?.text || ''),
          properties
        });
      }
    }
  }
  
  // Process inherited styles if present
  if (cdpMatchedStyles.inherited) {
    for (const inherited of cdpMatchedStyles.inherited) {
      if (inherited.matchedCSSRules) {
        for (const rule of inherited.matchedCSSRules) {
          if (rule.rule && rule.rule.style) {
            const properties: Record<string, string> = {};
            
            for (const property of rule.rule.style.cssProperties) {
              if (property.name && property.value) {
                properties[property.name] = property.value;
              }
            }
            
            rules.push({
              selector: rule.rule.selectorList?.selectors?.map((s: any) => s.text).join(', ') || 'inherited',
              source: rule.rule.origin === 'user-agent' ? 'user-agent' : 
                      rule.rule.styleSheetId ? `stylesheet:${rule.rule.styleSheetId}` : 'inherited',
              specificity: calculateSpecificity(rule.rule.selectorList?.selectors?.[0]?.text || ''),
              properties
            });
          }
        }
      }
    }
  }
  
  return rules;
}

function calculateSpecificity(selector: string): string {
  // CSS specificity calculation
  // Format: inline,id,class,element
  let inline = 0;
  let ids = 0;
  let classes = 0;
  let elements = 0;
  
  if (!selector) return '0,0,0,0';
  
  // Count IDs (#id)
  ids = (selector.match(/#[\w-]+/g) || []).length;
  
  // Count classes (.class), attributes ([attr]), pseudo-classes (:hover)
  classes = (selector.match(/\.[\w-]+|\[[\w\-="':]+\]|:[\w-]+(?:\([^)]*\))?/g) || []).length;
  
  // Count elements (div, p, etc.) and pseudo-elements (::before)
  const elementMatches = selector.match(/\b[a-zA-Z][\w-]*\b|::[\w-]+/g) || [];
  elements = elementMatches.filter(match => 
    !match.startsWith('::') ? true : (elements++, false) // Count pseudo-elements separately but add to elements
  ).length;
  
  return `${inline},${ids},${classes},${elements}`;
}

function filterComputedStyles(
  styles: Record<string, string>, 
  requestedGroups: PropertyGroup[], 
  includeAll: boolean
): Record<string, string> {
  if (includeAll) {
    return styles;
  }
  
  const filtered: Record<string, string> = {};
  
  for (const [property, value] of Object.entries(styles)) {
    if (shouldIncludeProperty(property, requestedGroups, includeAll)) {
      // Truncate very long values for token efficiency
      const truncatedValue = truncateValue(property, value);
      filtered[property] = truncatedValue;
    }
  }
  
  return filtered;
}

function filterCascadeRules(
  rules: CascadeRule[], 
  requestedGroups: PropertyGroup[], 
  includeAll: boolean
): CascadeRule[] {
  if (includeAll) {
    return rules;
  }
  
  const filtered: CascadeRule[] = [];
  
  for (const rule of rules) {
    // Skip user-agent rules unless explicitly needed
    if (rule.source === 'user-agent' && !includeAll) {
      continue;
    }
    
    // Filter properties within the rule
    const filteredProperties: Record<string, string> = {};
    let hasRelevantProperties = false;
    
    for (const [property, value] of Object.entries(rule.properties)) {
      if (shouldIncludeProperty(property, requestedGroups, includeAll)) {
        filteredProperties[property] = truncateValue(property, value);
        hasRelevantProperties = true;
      }
    }
    
    // Only include rule if it has relevant properties
    if (hasRelevantProperties) {
      filtered.push({
        ...rule,
        properties: filteredProperties
      });
    }
  }
  
  return filtered;
}

function truncateValue(property: string, value: string): string {
  // Truncate very long values to reduce token usage
  if (value.length <= 100) {
    return value;
  }
  
  // Special handling for font-family - keep first 3 fonts
  if (property === 'font-family') {
    const fonts = value.split(',').map(f => f.trim());
    if (fonts.length > 3) {
      return fonts.slice(0, 3).join(', ') + ', ...';
    }
  }
  
  // For other long values, truncate with ellipsis
  return value.substring(0, 97) + '...';
}