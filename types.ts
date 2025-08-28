export interface InspectElementArgs {
  css_selector: string;
  url: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoxModel {
  content: Rect;
  padding: Rect;
  border: Rect;
  margin: Rect;
}

export interface CascadeRule {
  selector: string;
  source: string;
  specificity: string;
  properties: Record<string, string>;
}

export interface InspectionResult {
  screenshot: string;
  computed_styles: Record<string, string>;
  cascade_rules: CascadeRule[];
  box_model: BoxModel;
}

export interface ChromeTarget {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface ChromeVersion {
  Browser: string;
  'Protocol-Version': string;
  'User-Agent': string;
  'V8-Version': string;
  'WebKit-Version': string;
  webSocketDebuggerUrl: string;
}

export interface BrowserInstance {
  port: number;
  version?: ChromeVersion;
  targets: ChromeTarget[];
  chromeInstance?: any; // chrome-launcher instance
}

export interface CDPMessage {
  id: number;
  method: string;
  params?: any;
}

export interface CDPResponse {
  id: number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface MultipleTabsError {
  available_tabs: Array<{
    title: string;
    url: string;
  }>;
}

export class MultipleTabsException extends Error {
  public readonly availableTabs: Array<{ title: string; url: string }>;
  
  constructor(availableTabs: Array<{ title: string; url: string }>, targetTitle?: string) {
    const message = targetTitle 
      ? `Target not found: "${targetTitle}". Please specify one of the available tabs.`
      : 'Multiple tabs found. Please specify target_title.';
    super(message);
    this.name = 'MultipleTabsException';
    this.availableTabs = availableTabs;
  }
}