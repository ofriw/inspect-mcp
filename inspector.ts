import type { InspectElementArgs, InspectionResult, MultiInspectionResult, ElementInspection, ElementRelationship, BoxModel, CascadeRule, GroupedStyles, Rect, ElementMetrics } from './types.js';
import { ensureChromeWithCDP, connectToTarget, CDPClient } from './cdp-client.js';
import { 
  DEFAULT_PROPERTY_GROUPS, 
  shouldIncludeProperty, 
  categorizeProperties, 
  type PropertyGroup 
} from './property-groups.js';
import { BrowserScripts } from './browser-scripts.js';
import { Jimp } from 'jimp';

interface ViewportInfo {
  width: number;
  height: number;
}

// Reserved for future multi-element highlighting (currently CDP only supports single element)
const HIGHLIGHT_COLORS = [
  { r: 0, g: 0, b: 255, a: 0.8 }, // Bright Blue
  { r: 0, g: 255, b: 0, a: 0.8 }, // Bright Green
  { r: 255, g: 255, b: 0, a: 0.8 }, // Bright Yellow
  { r: 255, g: 128, b: 0, a: 0.8 }, // Orange
  { r: 255, g: 0, b: 255, a: 0.8 }, // Magenta
];

// Pixel tolerance for alignment detection
const ALIGNMENT_TOLERANCE = 1;

// Viewport manipulation constants
const MIN_ZOOM_FACTOR = 0.5;
const MAX_ZOOM_FACTOR = 3.0;
const TARGET_ELEMENT_COVERAGE = 0.4; // Target 40% viewport coverage
const CENTER_THRESHOLD = 0.3; // Center element if >30% away from viewport center

interface ViewportInfo {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  scrollX: number;
  scrollY: number;
}

interface ElementPosition {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

async function getViewportInfo(cdp: CDPClient): Promise<ViewportInfo> {
  const metrics = await cdp.send('Page.getLayoutMetrics');
  return {
    width: metrics.cssVisualViewport?.clientWidth || 1280,
    height: metrics.cssVisualViewport?.clientHeight || 1024,
    deviceScaleFactor: 1, // Use default - actual device scale is handled by Chrome automatically
    mobile: false,
    scrollX: metrics.cssVisualViewport?.pageLeft || 0,
    scrollY: metrics.cssVisualViewport?.pageTop || 0
  };
}

async function getElementMetrics(cdp: CDPClient, uniqueId: string): Promise<ElementMetrics | null> {
  const result = await cdp.send('Runtime.evaluate', {
    expression: BrowserScripts.getElementMetrics(uniqueId),
    returnByValue: true
  });

  if (result.exceptionDetails) {
    console.warn('Failed to get element metrics:', result.exceptionDetails);
    return null;
  }

  return result.result.value as ElementMetrics | null;
}

function convertElementMetricsToBoxModel(metrics: ElementMetrics): BoxModel {
  const { viewport, margin, padding, border } = metrics;
  
  // viewport from getBoundingClientRect() is ALWAYS the border box (content + padding + border)
  const borderBox = viewport;
  
  return {
    // Margin box (outermost) - expand border box by margins
    margin: {
      x: borderBox.x - margin.left,
      y: borderBox.y - margin.top,
      width: borderBox.width + margin.left + margin.right,
      height: borderBox.height + margin.top + margin.bottom
    },
    // Border box - exactly what getBoundingClientRect() returns
    border: {
      x: borderBox.x,
      y: borderBox.y,
      width: borderBox.width,
      height: borderBox.height
    },
    // Padding box - shrink border box by border widths
    padding: {
      x: borderBox.x + border.left,
      y: borderBox.y + border.top,
      width: borderBox.width - border.left - border.right,
      height: borderBox.height - border.top - border.bottom
    },
    // Content box - shrink padding box by padding
    content: {
      x: borderBox.x + border.left + padding.left,
      y: borderBox.y + border.top + padding.top,
      width: borderBox.width - border.left - border.right - padding.left - padding.right,
      height: borderBox.height - border.top - border.bottom - padding.top - padding.bottom
    }
  };
}

async function centerElement(cdp: CDPClient, uniqueId: string): Promise<void> {
  await cdp.send('Runtime.evaluate', {
    expression: BrowserScripts.centerElement(uniqueId)
  });
}

async function centerMultipleElements(cdp: CDPClient, uniqueIds: string[]): Promise<void> {
  await cdp.send('Runtime.evaluate', {
    expression: BrowserScripts.centerMultipleElements(uniqueIds)
  });
}

function calculateOptimalZoom(elementPosition: ElementPosition, viewport: ViewportInfo): number {
  const elementArea = elementPosition.width * elementPosition.height;
  const viewportArea = viewport.width * viewport.height;
  const coverage = elementArea / viewportArea;
  
  let zoomFactor = 1;
  
  if (coverage < 0.1) {
    // Element too small, zoom in
    zoomFactor = Math.min(MAX_ZOOM_FACTOR, Math.sqrt(TARGET_ELEMENT_COVERAGE / coverage));
  } else if (coverage > 0.8) {
    // Element too large, zoom out 
    zoomFactor = Math.max(MIN_ZOOM_FACTOR, Math.sqrt(0.6 / coverage));
  }
  
  return Math.round(zoomFactor * 100) / 100; // Round to 2 decimals
}

function calculateMultiElementZoom(elementPositions: ElementPosition[], viewport: ViewportInfo): number {
  // Calculate bounding box of all elements
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  
  elementPositions.forEach(pos => {
    const left = pos.centerX - pos.width / 2;
    const top = pos.centerY - pos.height / 2;
    const right = pos.centerX + pos.width / 2;
    const bottom = pos.centerY + pos.height / 2;
    
    minX = Math.min(minX, left);
    minY = Math.min(minY, top);
    maxX = Math.max(maxX, right);
    maxY = Math.max(maxY, bottom);
  });
  
  const groupWidth = maxX - minX;
  const groupHeight = maxY - minY;
  const groupArea = groupWidth * groupHeight;
  const viewportArea = viewport.width * viewport.height;
  const coverage = groupArea / viewportArea;
  
  let zoomFactor = 1;
  
  if (coverage < 0.2) {
    // Group too small, zoom in
    zoomFactor = Math.min(MAX_ZOOM_FACTOR, Math.sqrt(0.6 / coverage));
  } else if (coverage > 0.9) {
    // Group too large, zoom out
    zoomFactor = Math.max(MIN_ZOOM_FACTOR, Math.sqrt(0.7 / coverage));
  }
  
  return Math.round(zoomFactor * 100) / 100;
}

function shouldCenterElement(elementPosition: ElementPosition, viewport: ViewportInfo): boolean {
  const viewportCenterX = viewport.width / 2;
  const viewportCenterY = viewport.height / 2;
  
  const distanceFromCenterX = Math.abs(elementPosition.centerX - viewportCenterX);
  const distanceFromCenterY = Math.abs(elementPosition.centerY - viewportCenterY);
  
  const thresholdX = viewport.width * CENTER_THRESHOLD;
  const thresholdY = viewport.height * CENTER_THRESHOLD;
  
  return distanceFromCenterX > thresholdX || distanceFromCenterY > thresholdY;
}

async function setViewportScale(cdp: CDPClient, viewport: ViewportInfo, zoomFactor: number): Promise<void> {
  await cdp.send('Emulation.setPageScaleFactor', {
    pageScaleFactor: zoomFactor
  });
}

async function resetViewportScale(cdp: CDPClient): Promise<void> {
  await cdp.send('Emulation.setPageScaleFactor', {
    pageScaleFactor: 1
  });
}

async function highlightElements(cdp: CDPClient, nodeIds: number[]): Promise<void> {
  // NOTE: This function is kept for compatibility but we no longer use CDP overlays
  // Highlighting is now done by drawing directly on screenshots in drawHighlightOnScreenshot()
  // Clear any existing overlay to ensure clean screenshots
  if (nodeIds.length > 0) {
    await cdp.send('Overlay.hideHighlight');
  }
}

/**
 * Draws highlight boxes directly on a screenshot image
 * This bypasses CDP overlay issues and works correctly with zoom
 */
async function drawHighlightOnScreenshot(
  screenshotBuffer: Buffer,
  boxModel: BoxModel,
  viewportInfo: ViewportInfo,
  clipRegion?: { x: number; y: number; width: number; height: number },
  zoomFactor: number = 1,
  elementMetrics?: ElementMetrics | null
): Promise<Buffer> {
  try {
    // Load screenshot into Jimp
    const image = await Jimp.read(screenshotBuffer);
    
    // Transform coordinates using our clean coordinate transformation pipeline
    let adjustedBoxModel = boxModel;
    
    // Step 1: Calculate expected dimensions and scale factors
    let expectedWidth = viewportInfo.width;
    let expectedHeight = viewportInfo.height;
    
    // If clipped, expected dimensions are the clip dimensions
    if (clipRegion) {
      expectedWidth = clipRegion.width;
      expectedHeight = clipRegion.height;
    }
    
    const actualScaleX = image.bitmap.width / expectedWidth;
    const actualScaleY = image.bitmap.height / expectedHeight;
    
    // Add comprehensive diagnostic logging
    console.error(`=== Screenshot Analysis ===`);
    console.error(`  Viewport: ${viewportInfo.width}x${viewportInfo.height}`);
    console.error(`  Clip region: ${clipRegion ? `${clipRegion.x},${clipRegion.y} ${clipRegion.width}x${clipRegion.height}` : 'none'}`);
    console.error(`  Expected dimensions: ${expectedWidth}x${expectedHeight}`);
    console.error(`  Actual screenshot: ${image.bitmap.width}x${image.bitmap.height}`);
    console.error(`  Scale factors: X=${actualScaleX.toFixed(3)}, Y=${actualScaleY.toFixed(3)}`);
    console.error(`  Box model margin before: ${boxModel.margin.x},${boxModel.margin.y} ${boxModel.margin.width}x${boxModel.margin.height}`);
    
    // Step 2: Apply viewport-to-screenshot coordinate scaling if needed
    if (Math.abs(actualScaleX - 1) > 0.01 || Math.abs(actualScaleY - 1) > 0.01) {
      adjustedBoxModel = {
        content: scaleRect(adjustedBoxModel.content, actualScaleX, actualScaleY),
        padding: scaleRect(adjustedBoxModel.padding, actualScaleX, actualScaleY),
        border: scaleRect(adjustedBoxModel.border, actualScaleX, actualScaleY),
        margin: scaleRect(adjustedBoxModel.margin, actualScaleX, actualScaleY)
      };
      console.error(`  Box model margin after scaling: ${adjustedBoxModel.margin.x},${adjustedBoxModel.margin.y} ${adjustedBoxModel.margin.width}x${adjustedBoxModel.margin.height}`);
    }
    
    // Step 3: Apply clip region adjustment if screenshot is clipped
    if (clipRegion) {
      // Scale the clip region by the same device pixel ratio as the coordinates
      const scaledClip = (Math.abs(actualScaleX - 1) > 0.01 || Math.abs(actualScaleY - 1) > 0.01) ? {
        x: clipRegion.x * actualScaleX,
        y: clipRegion.y * actualScaleY,
        width: clipRegion.width * actualScaleX,
        height: clipRegion.height * actualScaleY
      } : clipRegion;
      
      console.error(`  Scaled clip: ${scaledClip.x},${scaledClip.y} ${scaledClip.width}x${scaledClip.height}`);
      
      adjustedBoxModel = {
        content: adjustRect(adjustedBoxModel.content, scaledClip),
        padding: adjustRect(adjustedBoxModel.padding, scaledClip),
        border: adjustRect(adjustedBoxModel.border, scaledClip),
        margin: adjustRect(adjustedBoxModel.margin, scaledClip)
      };
      console.error(`  Box model margin after clip adjust: ${adjustedBoxModel.margin.x},${adjustedBoxModel.margin.y} ${adjustedBoxModel.margin.width}x${adjustedBoxModel.margin.height}`);
    }
    
    // Draw highlight layers (outermost to innermost)
    // Margin - Yellow
    drawRectangleOutline(image, adjustedBoxModel.margin, 0xFFFF00FF, 1);
    
    // Border - Red  
    drawRectangleOutline(image, adjustedBoxModel.border, 0xFF0000FF, 2);
    
    // Padding - Green
    drawRectangleOutline(image, adjustedBoxModel.padding, 0x00FF00FF, 1);
    
    // Content - Blue with fill
    drawRectangleFilled(image, adjustedBoxModel.content, 0x0078FF44);
    drawRectangleOutline(image, adjustedBoxModel.content, 0x0078FFFF, 2);
    
    // Draw rulers extending from the element
    drawRulers(image, adjustedBoxModel.border, image.bitmap.width, image.bitmap.height);
    
    // Return modified image as buffer
    return await image.getBuffer('image/png');
    
  } catch (error) {
    console.warn('Failed to draw highlight on screenshot:', error);
    // Return original screenshot if drawing fails
    return screenshotBuffer;
  }
}

function scaleRect(rect: Rect, scaleX: number, scaleY?: number): Rect {
  const actualScaleY = scaleY !== undefined ? scaleY : scaleX;
  return {
    x: rect.x * scaleX,
    y: rect.y * actualScaleY,
    width: rect.width * scaleX,
    height: rect.height * actualScaleY
  };
}

function adjustRect(rect: Rect, clip: { x: number; y: number; width: number; height: number }): Rect {
  return {
    x: Math.max(0, rect.x - clip.x),
    y: Math.max(0, rect.y - clip.y),
    width: rect.width,
    height: rect.height
  };
}


function drawRectangleOutline(image: any, rect: Rect, color: number, thickness: number): void {
  const { x, y, width, height } = rect;
  
  // Bounds check
  const imgWidth = image.bitmap.width;
  const imgHeight = image.bitmap.height;
  if (x >= imgWidth || y >= imgHeight || x + width <= 0 || y + height <= 0) {
    return;
  }
  
  // Top and bottom edges
  for (let px = Math.max(0, x); px < Math.min(imgWidth, x + width); px++) {
    for (let t = 0; t < thickness; t++) {
      if (y + t >= 0 && y + t < imgHeight) {
        image.setPixelColor(color >>> 0, px, y + t);
      }
      if (y + height - 1 - t >= 0 && y + height - 1 - t < imgHeight) {
        image.setPixelColor(color >>> 0, px, y + height - 1 - t);
      }
    }
  }
  
  // Left and right edges
  for (let py = Math.max(0, y); py < Math.min(imgHeight, y + height); py++) {
    for (let t = 0; t < thickness; t++) {
      if (x + t >= 0 && x + t < imgWidth) {
        image.setPixelColor(color >>> 0, x + t, py);
      }
      if (x + width - 1 - t >= 0 && x + width - 1 - t < imgWidth) {
        image.setPixelColor(color >>> 0, x + width - 1 - t, py);
      }
    }
  }
}

function drawRectangleFilled(image: any, rect: Rect, color: number): void {
  const { x, y, width, height } = rect;
  const imgWidth = image.bitmap.width;
  const imgHeight = image.bitmap.height;
  
  for (let px = Math.max(0, x); px < Math.min(imgWidth, x + width); px++) {
    for (let py = Math.max(0, y); py < Math.min(imgHeight, y + height); py++) {
      // Blend with existing pixel for transparency effect
      const existing = image.getPixelColor(px, py);
      const blended = blendColors(existing, color);
      image.setPixelColor(blended, px, py);
    }
  }
}

function drawRulers(image: any, elementRect: Rect, imgWidth: number, imgHeight: number): void {
  const rulerColor = 0xFF00FFFF; // Magenta
  
  // Vertical ruler at element's left edge
  const centerX = Math.floor(elementRect.x + elementRect.width / 2);
  if (centerX >= 0 && centerX < imgWidth) {
    for (let y = 0; y < imgHeight; y++) {
      image.setPixelColor(rulerColor >>> 0, centerX, y);
    }
  }
  
  // Horizontal ruler at element's center
  const centerY = Math.floor(elementRect.y + elementRect.height / 2);
  if (centerY >= 0 && centerY < imgHeight) {
    for (let x = 0; x < imgWidth; x++) {
      image.setPixelColor(rulerColor >>> 0, x, centerY);
    }
  }
}

function blendColors(background: number, foreground: number): number {
  // Simple alpha blending
  const bgR = (background >> 24) & 0xFF;
  const bgG = (background >> 16) & 0xFF;
  const bgB = (background >> 8) & 0xFF;
  const bgA = background & 0xFF;
  
  const fgR = (foreground >> 24) & 0xFF;
  const fgG = (foreground >> 16) & 0xFF;
  const fgB = (foreground >> 8) & 0xFF;
  const fgA = foreground & 0xFF;
  
  const alpha = fgA / 255;
  const invAlpha = 1 - alpha;
  
  const r = Math.floor(fgR * alpha + bgR * invAlpha);
  const g = Math.floor(fgG * alpha + bgG * invAlpha);
  const b = Math.floor(fgB * alpha + bgB * invAlpha);
  const a = Math.max(fgA, bgA);
  
  // Convert to unsigned 32-bit integer to avoid negative values
  return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
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
      expression: BrowserScripts.markElementsWithIds(css_selector, limit),
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
    
    if (nodeIds.length === 1) {
      // Single element - return simple structure
      return await inspectSingleElement(
        css_selector,
        nodeIds[0], 
        cdp, 
        property_groups as PropertyGroup[], 
        css_edits,
        args.autoCenter !== false, // Default to true unless explicitly disabled
        args.autoZoom !== false,   // Default to true unless explicitly disabled
        args.zoomFactor
      );
    } else {
      // Multiple elements - return with relationships
      return await inspectMultipleElements(
        css_selector,
        nodeIds, 
        cdp, 
        property_groups as PropertyGroup[], 
        css_edits,
        args.autoCenter !== false, // Default to true unless explicitly disabled
        args.autoZoom !== false,   // Default to true unless explicitly disabled
        args.zoomFactor
      );
    }
    
  } finally {
    // Clean up all data-inspect-id attributes before closing CDP
    try {
      await cdp.send('Runtime.evaluate', {
        expression: BrowserScripts.cleanupInspectIds()
      });
    } catch (cleanupError) {
      console.warn('Failed to clean up data-inspect-id attributes:', cleanupError);
    }
    cdp.close();
  }
}

async function inspectSingleElement(
  selector: string,
  nodeId: number,
  cdp: CDPClient,
  property_groups: PropertyGroup[],
  css_edits?: Record<string, string>,
  autoCenter: boolean = true,
  autoZoom: boolean = true,
  zoomFactor?: number
): Promise<InspectionResult> {
  
  // Apply CSS edits if provided
  if (css_edits && Object.keys(css_edits).length > 0) {
    await cdp.setInlineStyles(nodeId, css_edits);
  }
  
  // Find the unique ID for this element to use for coordinate retrieval
  const uniqueIdResult = await cdp.send('Runtime.evaluate', {
    expression: BrowserScripts.findOrCreateUniqueId(selector),
    returnByValue: true
  });
  
  const uniqueId = uniqueIdResult.result.value;
  if (!uniqueId) {
    throw new Error(`Unable to get element for selector: ${selector}. Element may not be visible.`);
  }

  // Get initial element metrics using JavaScript for reliable coordinates
  const initialMetrics = await getElementMetrics(cdp, uniqueId);
  if (!initialMetrics) {
    throw new Error(`Unable to get element metrics for: ${selector}. Element may not be visible.`);
  }
  
  const initialBoxModel = convertElementMetricsToBoxModel(initialMetrics);
  
  // Get viewport info for centering and zoom calculations
  const viewportInfo = await getViewportInfo(cdp);
  
  // Create element position info using reliable JavaScript coordinates
  const elementPosition: ElementPosition = {
    centerX: initialMetrics.viewport.x + initialMetrics.viewport.width / 2,
    centerY: initialMetrics.viewport.y + initialMetrics.viewport.height / 2,
    width: initialMetrics.viewport.width,
    height: initialMetrics.viewport.height
  };
  
  // Store original viewport state for restoration
  const originalViewport = { ...viewportInfo };
  let appliedZoomFactor = 1;
  
  try {
    // Apply centering if enabled and element is not already centered
    if (autoCenter && uniqueId && shouldCenterElement(elementPosition, viewportInfo)) {
      await centerElement(cdp, uniqueId);
      // Small delay to allow scroll to complete
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Calculate and apply zoom if enabled
    if (autoZoom || zoomFactor) {
      if (zoomFactor) {
        // Clamp manual zoom factor to valid range
        appliedZoomFactor = Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, zoomFactor));
      } else {
        appliedZoomFactor = calculateOptimalZoom(elementPosition, viewportInfo);
      }
      
      if (appliedZoomFactor !== 1) {
        await setViewportScale(cdp, viewportInfo, appliedZoomFactor);
        // Small delay to allow zoom to apply
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    // Get updated element metrics after centering and zooming
    const updatedMetrics = await getElementMetrics(cdp, uniqueId);
    const boxModel = updatedMetrics ? convertElementMetricsToBoxModel(updatedMetrics) : initialBoxModel;
    
    // Get computed styles
    const computedStylesResult = await cdp.send('CSS.getComputedStyleForNode', { nodeId });
    const allComputedStyles = convertComputedStyles(computedStylesResult.computedStyle);
    const filteredComputedStyles = filterComputedStyles(allComputedStyles, property_groups, false);
    
    // Get matching CSS rules (cascade)
    const matchedStylesResult = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
    const allCascadeRules = convertCascadeRules(matchedStylesResult);
    const filteredCascadeRules = filterCascadeRules(allCascadeRules, property_groups, false);
    
    // Highlight element with overlay AFTER zoom to ensure correct coordinates
    await highlightElements(cdp, [nodeId]);
    
    // Capture screenshot with overlay (clip if zoomed)
    let screenshotOptions: any = { format: 'png' };
    
    if (appliedZoomFactor > 1) {
      // Calculate clip bounds around the element with padding 
      // After zoom, DOM.getBoxModel coordinates are already in viewport space
      const padding = 100;
      const x = Math.max(0, Math.floor(boxModel.margin.x - padding));
      const y = Math.max(0, Math.floor(boxModel.margin.y - padding));
      const width = Math.max(1, Math.min(viewportInfo.width - x, 
                                       Math.ceil(boxModel.margin.width + 2 * padding)));
      const height = Math.max(1, Math.min(viewportInfo.height - y,
                                        Math.ceil(boxModel.margin.height + 2 * padding)));
      
      // Only apply clip if values are valid
      if (x >= 0 && y >= 0 && width > 0 && height > 0 && 
          x + width <= viewportInfo.width && y + height <= viewportInfo.height) {
        screenshotOptions.clip = { x, y, width, height, scale: 1 };
      }
    }
    
    const screenshotResult = await cdp.send('Page.captureScreenshot', screenshotOptions);
    
    if (!screenshotResult.data) {
      throw new Error('Failed to capture screenshot. The page may not be loaded or visible.');
    }
    
    // Draw custom highlights on the screenshot
    let screenshotBuffer: Buffer = Buffer.from(screenshotResult.data, 'base64');
    screenshotBuffer = await drawHighlightOnScreenshot(
      screenshotBuffer,
      boxModel,
      viewportInfo,
      screenshotOptions.clip,
      appliedZoomFactor,
      updatedMetrics
    );
    const enhancedScreenshot = screenshotBuffer.toString('base64');
    
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
      screenshot: `data:image/png;base64,${enhancedScreenshot}`,
      computed_styles: filteredComputedStyles,
      grouped_styles: groupedStyles,
      cascade_rules: filteredCascadeRules,
      box_model: boxModel,
      applied_edits: css_edits && Object.keys(css_edits).length > 0 ? css_edits : undefined,
      viewport_adjustments: {
        original_position: {
          centerX: elementPosition.centerX,
          centerY: elementPosition.centerY
        },
        centered: autoCenter && shouldCenterElement(elementPosition, viewportInfo),
        zoom_factor: appliedZoomFactor,
        original_viewport: originalViewport
      },
      stats
    };
    
  } finally {
    // Clean up: restore viewport and remove temporary attributes
    try {
      if (appliedZoomFactor !== 1) {
        await resetViewportScale(cdp);
      }
      
      // Clean up temporary data-inspect-id if we added one
      if (uniqueId && uniqueId.startsWith('_inspect_temp_')) {
        await cdp.send('Runtime.evaluate', {
          expression: BrowserScripts.cleanupTempId(uniqueId)
        });
      }
    } catch (cleanupError) {
      // Don't throw cleanup errors, just log them
      console.warn('Cleanup failed:', cleanupError);
    }
  }
}

async function inspectMultipleElements(
  selector: string,
  nodeIds: number[],
  cdp: CDPClient,
  property_groups: PropertyGroup[],
  css_edits?: Record<string, string>,
  autoCenter: boolean = true,
  autoZoom: boolean = true,
  zoomFactor?: number
): Promise<MultiInspectionResult> {
  const elements: ElementInspection[] = [];
  const nodeData: Array<{ selector: string, nodeId: number, boxModel: BoxModel }> = [];
  const elementPositions: ElementPosition[] = [];
  
  let totalProperties = 0;
  let filteredProperties = 0;
  let totalRules = 0;
  let filteredRules = 0;
  
  // Get viewport info for centering and zoom calculations
  const viewportInfo = await getViewportInfo(cdp);
  const originalViewport = { ...viewportInfo };
  let appliedZoomFactor = 1;
  
  try {
    // First pass: collect initial box models and positions for all elements
    for (let i = 0; i < nodeIds.length; i++) {
      const nodeId = nodeIds[i];
      
      // Apply CSS edits if provided
      if (css_edits && Object.keys(css_edits).length > 0) {
        await cdp.setInlineStyles(nodeId, css_edits);
      }
      
      // Get initial box model for bounds and positioning
      const boxModelResult = await cdp.send('DOM.getBoxModel', { nodeId });
      if (!boxModelResult.model) {
        throw new Error(`Unable to get box model for element ${i + 1} of ${nodeIds.length}: ${selector}. Element may not be visible.`);
      }
      const boxModel = convertBoxModel(boxModelResult.model);
      
      // Store element position for centering and zoom calculations
      const elementPosition: ElementPosition = {
        centerX: boxModel.border.x + boxModel.border.width / 2,
        centerY: boxModel.border.y + boxModel.border.height / 2,
        width: boxModel.border.width,
        height: boxModel.border.height
      };
      elementPositions.push(elementPosition);
      
      // Store for distance calculations  
      nodeData.push({ selector: `${selector}[${i}]`, nodeId, boxModel });
    }
    
    // Get unique IDs for all elements for centering
    const uniqueIdsResult = await cdp.send('Runtime.evaluate', {
      expression: `
        (function() {
          const elements = Array.from(document.querySelectorAll('${selector.replace(/'/g, "\\'")}'));
          return elements.map((el, i) => {
            let uniqueId = el.getAttribute('data-inspect-id');
            if (!uniqueId) {
              uniqueId = '_inspect_temp_' + Date.now() + '_' + i;
              el.setAttribute('data-inspect-id', uniqueId);
            }
            return uniqueId;
          });
        })();
      `,
      returnByValue: true
    });
    const uniqueIds = uniqueIdsResult.result.value;
    
    // Apply centering if enabled
    if (autoCenter && uniqueIds && uniqueIds.length > 0) {
      await centerMultipleElements(cdp, uniqueIds);
      // Small delay to allow scroll to complete
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Calculate and apply zoom if enabled
    if (autoZoom || zoomFactor) {
      if (zoomFactor) {
        // Clamp manual zoom factor to valid range
        appliedZoomFactor = Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, zoomFactor));
      } else {
        appliedZoomFactor = calculateMultiElementZoom(elementPositions, viewportInfo);
      }
      
      if (appliedZoomFactor !== 1) {
        await setViewportScale(cdp, viewportInfo, appliedZoomFactor);
        // Small delay to allow zoom to apply
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    // Second pass: process each element for styles and updated positions
    for (let i = 0; i < nodeIds.length; i++) {
      const nodeId = nodeIds[i];
      
      // Get updated box model after centering and zooming
      const updatedBoxModelResult = await cdp.send('DOM.getBoxModel', { nodeId });
      const boxModel = updatedBoxModelResult.model ? 
        convertBoxModel(updatedBoxModelResult.model) : 
        nodeData[i].boxModel; // fallback to original
      
      // Update nodeData with new box model
      nodeData[i].boxModel = boxModel;
      
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
      
      // Accumulate stats
      totalProperties += Object.keys(allComputedStyles).length;
      filteredProperties += Object.keys(filteredComputedStyles).length;
      totalRules += allCascadeRules.length;
      filteredRules += filteredCascadeRules.length;
    }
  
    // Highlight the first element AFTER zoom to ensure correct coordinates
    await highlightElements(cdp, nodeIds);
    
    // Wait for highlight overlay to render
    await new Promise(resolve => setTimeout(resolve, 200));
  
  // Capture screenshot with all overlays (clip if zoomed)
  let screenshotOptions: any = { format: 'png' };
  
  if (appliedZoomFactor > 1 && nodeData.length > 0) {
    // Calculate bounding box for all elements
    // After zoom, DOM.getBoxModel coordinates are already in viewport space
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    
    for (const data of nodeData) {
      const box = data.boxModel.margin;
      minX = Math.min(minX, box.x);
      minY = Math.min(minY, box.y);
      maxX = Math.max(maxX, box.x + box.width);
      maxY = Math.max(maxY, box.y + box.height);
    }
    
    // Add padding around the group (increased to include overlays)
    const padding = 100;
    const x = Math.max(0, Math.floor(minX - padding));
    const y = Math.max(0, Math.floor(minY - padding));
    const width = Math.max(1, Math.min(viewportInfo.width - x, 
                                     Math.ceil(maxX - minX + 2 * padding)));
    const height = Math.max(1, Math.min(viewportInfo.height - y,
                                      Math.ceil(maxY - minY + 2 * padding)));
    
    // Only apply clip if values are valid
    if (x >= 0 && y >= 0 && width > 0 && height > 0 && 
        x + width <= viewportInfo.width && y + height <= viewportInfo.height) {
      screenshotOptions.clip = { x, y, width, height, scale: 1 };
    }
  }
  
  const screenshotResult = await cdp.send('Page.captureScreenshot', screenshotOptions);
  
  if (!screenshotResult.data) {
    throw new Error('Failed to capture screenshot. The page may not be loaded or visible.');
  }
  
  // Draw custom highlights on the screenshot (highlight the first element)
  let screenshotBuffer: Buffer = Buffer.from(screenshotResult.data, 'base64');
  if (nodeData.length > 0) {
    screenshotBuffer = await drawHighlightOnScreenshot(
      screenshotBuffer,
      nodeData[0].boxModel,
      viewportInfo,
      screenshotOptions.clip,
      appliedZoomFactor
    );
  }
  const enhancedScreenshot = screenshotBuffer.toString('base64');
  
  // Clear all overlays
  await cdp.send('Overlay.hideHighlight');
  
  // Calculate relationships between elements
  const relationships = calculateElementRelationships(nodeData);
  
    const result: MultiInspectionResult = {
      elements,
      relationships,
      screenshot: `data:image/png;base64,${enhancedScreenshot}`,
      viewport_adjustments: {
        original_positions: elementPositions,
        centered: autoCenter,
        zoom_factor: appliedZoomFactor,
        original_viewport: originalViewport
      },
      stats: {
        total_properties: totalProperties,
        filtered_properties: filteredProperties,
        total_rules: totalRules,
        filtered_rules: filteredRules
      }
    };
    
    return result;
    
  } finally {
    // Clean up: restore viewport and remove temporary attributes
    try {
      if (appliedZoomFactor !== 1) {
        await resetViewportScale(cdp);
      }
      
      // Clean up all data-inspect-id attributes
      await cdp.send('Runtime.evaluate', {
        expression: BrowserScripts.cleanupInspectIds()
      });
    } catch (cleanupError) {
      // Don't throw cleanup errors, just log them
      console.warn('Multi-element cleanup failed:', cleanupError);
    }
  }
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