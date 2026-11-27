-- SoyTuTaxi · "account" payment mode: the trip is billed to a hotel/agency account on its monthly invoice.
-- (Separate migration: a new enum value can only be used after the transaction that adds it commits.)
alter type public.payment_mode add value if not exists 'account';
