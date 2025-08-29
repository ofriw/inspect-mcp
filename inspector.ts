import type { InspectElementArgs, InspectionResult, BoxModel, CascadeRule, GroupedStyles } from './types.js';
import { ensureChromeWithCDP, connectToTarget, CDPClient } from './cdp-client.js';
import { 
  DEFAULT_PROPERTY_GROUPS, 
  shouldIncludeProperty, 
  categorizeProperties, 
  type PropertyGroup 
} from './property-groups.js';

export async function inspectElement(args: InspectElementArgs): Promise<InspectionResult> {
  const { 
    css_selector, 
    url, 
    property_groups = DEFAULT_PROPERTY_GROUPS,
    include_all_properties = false 
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
    
    // Find element (querySelector returns first matching element)
    const nodeResult = await cdp.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: css_selector
    });
    
    if (!nodeResult.nodeId) {
      throw new Error(`Element not found: ${css_selector}`);
    }
    
    const nodeId = nodeResult.nodeId;
    
    // Get box model for bounds
    const boxModelResult = await cdp.send('DOM.getBoxModel', { nodeId });
    if (!boxModelResult.model) {
      throw new Error(`Unable to get box model for element: ${css_selector}. Element may not be visible.`);
    }
    const boxModel = convertBoxModel(boxModelResult.model);
    
    // Get computed styles
    const computedStylesResult = await cdp.send('CSS.getComputedStyleForNode', { nodeId });
    const allComputedStyles = convertComputedStyles(computedStylesResult.computedStyle);
    const filteredComputedStyles = filterComputedStyles(allComputedStyles, property_groups as PropertyGroup[], include_all_properties);
    
    // Get matching CSS rules (cascade)
    const matchedStylesResult = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
    const allCascadeRules = convertCascadeRules(matchedStylesResult);
    const filteredCascadeRules = filterCascadeRules(allCascadeRules, property_groups as PropertyGroup[], include_all_properties);
    
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
    });
    
    // Capture full viewport screenshot with overlay
    const screenshotResult = await cdp.send('Page.captureScreenshot', {
      format: 'png'
    });
    
    if (!screenshotResult.data) {
      throw new Error('Failed to capture screenshot. The page may not be loaded or visible.');
    }
    
    // Clear overlay
    await cdp.send('Overlay.hideHighlight');
    
    // Create grouped styles if filtering is applied
    const groupedStyles = !include_all_properties ? 
      categorizeProperties(filteredComputedStyles) : undefined;
    
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
      stats
    };
    
  } finally {
    cdp.close();
  }
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