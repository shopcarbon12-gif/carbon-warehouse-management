-- Social → Google Business Profile (owner, 2026-10-29): each post that goes to
-- Google carries a button, chosen per post (Google's own list: Buy, Order online,
-- Learn more, Book, Sign up, Call now, or none). NULL = Buy.
ALTER TABLE public.marketing_posts ADD COLUMN IF NOT EXISTS google_button text NULL;
