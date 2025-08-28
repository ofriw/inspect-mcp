import type { InspectElementArgs, InspectionResult, BoxModel, CascadeRule } from './types.js';
import { ensureChromeWithCDP, connectToTarget, CDPClient } from './cdp-client.js';

export async function inspectElement(args: InspectElementArgs): Promise<InspectionResult> {
  const { css_selector, url } = args;
  
  // Get or launch Chrome instance
  const browser = await ensureChromeWithCDP();
  
  // Connect to target
  const ws = await connectToTarget(browser, url);
  const cdp = new CDPClient(ws);
  
  try {
    // These domains should already be enabled during navigation
    // But enable them again in case we're reusing a tab
    console.error('Ensuring CDP domains are enabled...');
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    await cdp.send('Page.enable');
    await cdp.send('Overlay.enable');
    
    // Get document with retry logic
    console.error('Getting document...');
    let doc;
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
      try {
        doc = await cdp.send('DOM.getDocument');
        if (doc && doc.root && doc.root.nodeId) {
          console.error(`Document retrieved successfully (attempt ${attempts + 1})`);
          break;
        } else {
          throw new Error('Document root is empty or invalid');
        }
      } catch (error) {
        attempts++;
        console.error(`DOM.getDocument attempt ${attempts} failed:`, error);
        if (attempts >= maxAttempts) {
          throw new Error(`Failed to get document after ${maxAttempts} attempts: ${error}`);
        }
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, 500 * attempts));
      }
    }
    
    // Find element (querySelector returns first matching element)
    console.error(`Searching for element: ${css_selector}`);
    const nodeResult = await cdp.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: css_selector
    });
    
    if (!nodeResult.nodeId) {
      console.error(`Element not found with selector: ${css_selector}`);
      console.error('Document root nodeId:', doc.root.nodeId);
      throw new Error(`Element not found: ${css_selector}`);
    }
    
    console.error(`Element found with nodeId: ${nodeResult.nodeId}`);
    const nodeId = nodeResult.nodeId;
    
    // Get box model for bounds
    console.error('Getting box model...');
    const boxModelResult = await cdp.send('DOM.getBoxModel', { nodeId });
    if (!boxModelResult.model) {
      throw new Error(`Unable to get box model for element: ${css_selector}. Element may not be visible.`);
    }
    const boxModel = convertBoxModel(boxModelResult.model);
    console.error('Box model retrieved successfully');
    
    // Get computed styles
    console.error('Getting computed styles...');
    const computedStylesResult = await cdp.send('CSS.getComputedStyleForNode', { nodeId });
    const computedStyles = convertComputedStyles(computedStylesResult.computedStyle);
    console.error('Computed styles retrieved successfully');
    
    // Get matching CSS rules (cascade)
    console.error('Getting cascade rules...');
    const matchedStylesResult = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
    const cascadeRules = convertCascadeRules(matchedStylesResult);
    console.error('Cascade rules retrieved successfully');
    
    // Highlight element with overlay
    console.error('Highlighting element...');
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
    console.error('Element highlighted successfully');
    
    // Capture full viewport screenshot with overlay
    console.error('Capturing screenshot...');
    const screenshotResult = await cdp.send('Page.captureScreenshot', {
      format: 'png'
    });
    
    if (!screenshotResult.data) {
      throw new Error('Failed to capture screenshot. The page may not be loaded or visible.');
    }
    console.error('Screenshot captured successfully');
    
    // Clear overlay
    console.error('Clearing overlay...');
    await cdp.send('Overlay.hideHighlight');
    console.error('Overlay cleared successfully');
    
    console.error('Inspection completed successfully');
    return {
      screenshot: `data:image/png;base64,${screenshotResult.data}`,
      computed_styles: computedStyles,
      cascade_rules: cascadeRules,
      box_model: boxModel
    };
    
  } finally {
    console.error('Closing CDP connection...');
    cdp.close();
    console.error('CDP connection closed');
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