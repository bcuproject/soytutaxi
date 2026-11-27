-- SoyTuTaxi · Booking desk: a separate "agent" role (call/chat takers who create bookings and send
-- them to dispatch). Added on its own because a new enum value can't be used in the same transaction.
alter type public.member_role add value if not exists 'agent';
