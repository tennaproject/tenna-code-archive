export interface SearchRequest {
  id: number;
  term: string;
  findAll: boolean;
  isRegex: boolean;
  caseSensitive: boolean;
  indexUrl: string;
}

export interface SearchHit {
  html: string;
  index: number;
}

export interface SearchResponse {
  id: number;
  numHits: number;
  overflow: boolean;
  results: Record<string, SearchHit[]>;
  error?: string;
}
