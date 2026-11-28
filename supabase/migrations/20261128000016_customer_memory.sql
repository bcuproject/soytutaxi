-- SoyTuTaxi · Customer memory shared by the WhatsApp assistant and Sofía (voice): recent bookings with live ride
-- details, recent WhatsApp messages and previous calls (with Sofía's transcript), all for one phone number.

alter table public.wa_calls add column transcript text check (length(transcript) <= 8000);

-- Sofía posts the conversation when the call ends (service role, called by the whatsapp function).
create or replace function public.wa_call_transcript(p_call_id text, p_transcript text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.wa_calls set transcript = left(nullif(trim(p_transcript), ''), 8000)
   where provider_call_id = p_call_id and handled_by = 'bot';
$$;

-- Everything the assistant may know about the person on this number. Only this number's own data;
-- driver details only once the driver has accepted (confirmed assignment); never the driver's phone.
create or replace function public.wa_customer_context(p_operator uuid, p_phone text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with pax as (select p.* from public.passengers p where p.operator_id = p_operator and p.phone_e164 = p_phone),
  bk as (
    select b.*, a.iata, z.name as zone_name
      from public.bookings b join pax on pax.id = b.passenger_id
      join public.airports a on a.id = b.airport_id left join public.zones z on z.id = b.zone_id
     where b.operator_id = p_operator
       and (b.agreed_pickup_at > now() - interval '45 days' or b.created_at > now() - interval '45 days')
     order by b.agreed_pickup_at desc limit 8
  ),
  conv as (select c.* from public.wa_conversations c where c.operator_id = p_operator and c.phone_e164 = p_phone and c.kind = 'passenger')
  select jsonb_build_object(
    'name', coalesce((select full_name from pax limit 1), (select profile_name from conv limit 1)),
    'bookings', coalesce((select jsonb_agg(jsonb_build_object(
        'reference', bk.reference, 'state', bk.state, 'direction', bk.direction, 'airport', bk.iata, 'zone', bk.zone_name,
        'pickupPlace', bk.pickup_place ->> 'label', 'dropoffPlace', bk.dropoff_place ->> 'label',
        'pickupAt', bk.agreed_pickup_at, 'proposedPickupAt', bk.proposed_pickup_at,
        'flight', bk.flight_designator, 'flightStatus', bk.flight_status, 'flightEstimatedArrivalAt', bk.flight_estimated_arrival_at,
        'passengers', bk.passengers, 'largeBags', bk.large_bags, 'carryOn', bk.carry_on, 'vehicleClass', bk.vehicle_class,
        'amountMinor', bk.amount_minor, 'currency', bk.currency, 'paymentMode', bk.payment_mode, 'paid', bk.collection_state = 'collected',
        'cancelledReason', bk.cancelled_reason,
        'driver', (select jsonb_build_object('firstName', split_part(d.full_name, ' ', 1), 'vehicle', v.description, 'plate', v.plate,
                                             'stage', s.trip_stage)
                     from public.assignments s join public.drivers d on d.id = s.driver_id left join public.vehicles v on v.id = s.vehicle_id
                    where s.booking_id = bk.id and s.state = 'confirmed' limit 1),
        'rating', (select r.score from public.ratings r where r.booking_id = bk.id)) order by bk.agreed_pickup_at desc)
      from bk), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('at', m.created_at, 'from', case when m.direction = 'in' then 'customer'
                              when m.sent_by is not null then 'staff' else 'bot' end, 'text', left(m.preview, 400)) order by m.created_at)
      from (select m.* from public.wa_messages m join conv on conv.id = m.conversation_id
             where m.created_at > now() - interval '30 days' and m.preview <> ''
             order by m.created_at desc limit 24) m), '[]'::jsonb),
    'calls', coalesce((select jsonb_agg(jsonb_build_object('at', c.started_at, 'status', c.status, 'durationS', c.duration_s,
                              'handledBy', case when c.handled_by = 'bot' and c.transfer_taken_at is null then 'Sofía (bot)' else 'staff' end,
                              'transferred', c.transfer_taken_at is not null, 'note', c.bot_note,
                              'callbackPending', c.wants_callback and c.callback_done_at is null,
                              'booking', (select b.reference from public.bookings b where b.id = c.booking_id),
                              'transcript', right(c.transcript, 1500)) order by c.started_at)
      from (select * from public.wa_calls c where c.operator_id = p_operator and c.phone_e164 = p_phone
               and c.started_at > now() - interval '60 days' order by c.started_at desc limit 5) c), '[]'::jsonb)
  );
$$;

revoke all on function public.wa_call_transcript(text, text), public.wa_customer_context(uuid, text) from public, anon, authenticated;
grant execute on function public.wa_call_transcript(text, text), public.wa_customer_context(uuid, text) to service_role;
