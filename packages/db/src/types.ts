import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface ProductsTable {
  id: Generated<string>;
  sku: string;
  name: string;
  category: string;
  base_price_cents: number;
  stock_quantity: Generated<number>;
  is_active: Generated<boolean>;
  effective_price_cents: number;
  active_promotion_id: string | null;
  price_computed_at: Generated<Timestamp>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface PromotionsTable {
  id: Generated<string>;
  name: string;
  discount_type: 'percentage' | 'fixed';
  discount_value: number;
  starts_at: Timestamp;
  ends_at: Timestamp;
  target_type: 'product' | 'category' | null;
  target_product_id: string | null;
  target_category: string | null;
  status: Generated<'draft' | 'published' | 'cancelled'>;
  cancelled_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface IngestionJobsTable {
  id: Generated<string>;
  idempotency_key: string;
  bucket: string;
  object_key: string;
  file_size_bytes: number;
  chunks_total: Generated<number>;
  chunks_completed: Generated<number>;
  rows_upserted: Generated<number>;
  rows_rejected: Generated<number>;
  status: Generated<'pending' | 'processing' | 'completed' | 'partial' | 'failed'>;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface IngestionChunksTable {
  job_id: string;
  chunk_index: number;
  start_byte: number;
  end_byte: number;
  status: Generated<'pending' | 'processing' | 'completed' | 'failed'>;
  attempts: Generated<number>;
  rows_upserted: Generated<number>;
  rows_rejected: Generated<number>;
  error: string | null;
  completed_at: Timestamp | null;
}

export interface IngestionRowErrorsTable {
  id: Generated<number>;
  job_id: string;
  chunk_index: number;
  line_number: number | null;
  raw_line: string | null;
  reason: string;
  created_at: Generated<Timestamp>;
}

export interface Database {
  products: ProductsTable;
  promotions: PromotionsTable;
  ingestion_jobs: IngestionJobsTable;
  ingestion_chunks: IngestionChunksTable;
  ingestion_row_errors: IngestionRowErrorsTable;
}

export type Product = Selectable<ProductsTable>;
export type NewProduct = Insertable<ProductsTable>;
export type ProductUpdate = Updateable<ProductsTable>;
export type Promotion = Selectable<PromotionsTable>;
export type NewPromotion = Insertable<PromotionsTable>;
export type IngestionJob = Selectable<IngestionJobsTable>;
export type IngestionChunk = Selectable<IngestionChunksTable>;
