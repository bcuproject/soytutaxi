-- SoyTuTaxi · Indexes for the finance/document/account joins flagged by the Supabase performance advisor.
create index if not exists account_invoice_lines_invoice_idx on public.account_invoice_lines (invoice_id);
create index if not exists cash_entries_driver_open_idx on public.cash_entries (driver_id, created_at) where settlement_batch_id is null;
create index if not exists earnings_entries_driver_open_idx on public.earnings_entries (driver_id, created_at) where settlement_batch_id is null;
create index if not exists earnings_entries_batch_idx on public.earnings_entries (settlement_batch_id) where settlement_batch_id is not null;
create index if not exists cash_entries_batch_idx on public.cash_entries (settlement_batch_id) where settlement_batch_id is not null;
create index if not exists driver_documents_driver_idx on public.driver_documents (driver_id) where driver_id is not null;
create index if not exists driver_documents_vehicle_idx on public.driver_documents (vehicle_id) where vehicle_id is not null;
create index if not exists exceptions_booking_idx on public.exceptions (booking_id) where booking_id is not null;
create index if not exists refunds_booking_idx on public.refunds (booking_id);
create index if not exists earnings_entries_booking_idx on public.earnings_entries (booking_id) where booking_id is not null;
create index if not exists cash_entries_booking_idx on public.cash_entries (booking_id);
create index if not exists bookings_passenger_idx on public.bookings (passenger_id);
