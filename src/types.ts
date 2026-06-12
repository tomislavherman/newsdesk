export interface User {
  id: number;
  username: string;
  password_hash: string;
  role: 'admin' | 'user';
  approved: number;
  blocked: number;
  created_at: string;
}

export interface Source {
  id: number;
  user_id: number | null;
  url: string;
  name: string | null;
  feed_url: string | null;
  selector: string | null;
  date_selector: string | null;
  image_selector: string | null;
  fetch_type: 'rss' | 'html';
  max_age_days: number;
  color: string | null;
  active: number;
  analysis_notes: string | null;
  created_at: string;
}

export interface Article {
  id: number;
  source_id: number;
  url: string;
  title: string | null;
  summary: string | null;
  image_url: string | null;
  published_at: string | null;
  fetched_at: string;
  is_relevant: number;
  relevance_reason: string | null;
  seen: number;
  analysis_notes: string | null;
}

export interface ArticleWithSource extends Article {
  source_name: string | null;
  source_url: string;
  source_color: string | null;
  feedback_reason: string | null;
  user_dismissed: number;
}

export interface FeedbackRow {
  title: string | null;
  summary: string | null;
  reason: string | null;
}

export interface InsertArticleParams {
  source_id: number;
  url: string;
  title: string | null;
  summary: string | null;
  image_url: string | null;
  published_at: string | null;
  is_relevant: number;
  relevance_reason: string | null;
  analysis_notes: string | null;
}

export interface InsertSourceParams {
  user_id: number;
  url: string;
  name: string | null;
  feed_url: string | null;
  selector: string | null;
  date_selector: string | null;
  image_selector: string | null;
  fetch_type: 'rss' | 'html';
  max_age_days: number;
  color: string | null;
  analysis_notes: string | null;
}

export interface UpdateSourceParams {
  name: string | null;
  feed_url: string | null;
  selector: string | null;
  date_selector: string | null;
  image_selector: string | null;
  fetch_type: 'rss' | 'html';
  max_age_days: number;
  color: string | null;
}

export interface AdminSource {
  id: number;
  url: string;
  name: string | null;
  fetch_type: 'rss' | 'html';
  active: number;
  created_at: string;
  username: string | null;
}

export interface AdminArticle {
  id: number;
  url: string;
  title: string | null;
  fetched_at: string;
  is_relevant: number;
  seen: number;
  source_name: string | null;
  username: string | null;
}
