// Shared SEO types for the SEO Studio (audit, optimize, publish).
// Kept dependency-free so deterministic scoring can run on client and server.

export interface ImageAlt {
  /** Shopify MediaImage gid (gid://shopify/MediaImage/...) */
  id: string;
  url: string;
  altText: string;
}

export interface SeoFields {
  title: string; // product H1 / storefront title
  seoTitle: string; // <title> / meta title
  metaDescription: string; // meta description
  handle: string; // url slug
  bodyHtml: string; // product description (HTML)
  tags: string[];
  productType: string;
  vendor: string;
  imageAlts: ImageAlt[];
  focusKeyword?: string;
  secondaryKeywords?: string[];
}

export type Grade = "A" | "B" | "C" | "D" | "F";

export interface FieldScore {
  score: number; // 0-100
  grade: Grade;
  issues: string[];
  why: string;
}

export type SeoFieldKey =
  | "seoTitle"
  | "metaDescription"
  | "handle"
  | "title"
  | "bodyHtml"
  | "tags"
  | "productType"
  | "vendor"
  | "imageAlts";

export interface Scorecard {
  overall: number; // 0-100 weighted
  grade: Grade;
  fields: Partial<Record<SeoFieldKey, FieldScore>>;
}

export interface ProductContext {
  productId: string;
  handle: string;
  title: string;
  productType: string;
  vendor: string;
  tags: string[];
  price?: string;
  currency?: string;
  variantSkus?: string[];
  barcodes?: string[];
  colors?: string[];
  imageCount: number;
  onlineStoreUrl?: string;
}

/** Human-friendly labels for each field key (used by the UI). */
export const SEO_FIELD_LABELS: Record<SeoFieldKey, string> = {
  seoTitle: "SEO title (meta title)",
  metaDescription: "Meta description",
  handle: "URL handle",
  title: "Product title (H1)",
  bodyHtml: "Body description",
  tags: "Tags",
  productType: "Product type",
  vendor: "Vendor / brand",
  imageAlts: "Image alt text",
};

/** Ideal character ranges Google/ecom best practice targets. */
export const SEO_LIMITS = {
  seoTitleMin: 30,
  seoTitleMax: 60,
  metaDescriptionMin: 120,
  metaDescriptionMax: 155,
  handleMin: 3,
  handleMax: 60,
  // Product titles are preserved WMS brand names (often short, e.g. "TIGER SHIRT");
  // don't penalize a clean short product name.
  titleMin: 8,
  titleMax: 70,
  bodyMinChars: 300,
  altMin: 15,
  altMax: 125,
  tagsMin: 3,
  tagsMax: 20,
} as const;
