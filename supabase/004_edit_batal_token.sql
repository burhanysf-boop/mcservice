begin;

-- Status baru: Dibatalkan. Pengembalian dana dicatat terpisah.
alter table public.tickets drop constraint tickets_status_check,
 add constraint tickets_status_check check (status in ('Belum dicek','Sedang dicek','Menunggu konfirmasi','Menunggu suku cadang','Sedang dikerjakan','Siap diambil','Sudah diambil','Dibatalkan'));
alter table public.tickets add column refund integer not null default 0 check (refund >= 0);

create or replace function public.service_command(cmd text, ticket_id uuid, branch_code text, fields jsonb, operation_id uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare
 t public.tickets%rowtype;
 target text;
 value_num integer;
 assignee uuid;
 existing uuid;
 event_detail text := '';
 paid integer;
begin
 if auth.uid() is null or operation_id is null or branch_code is null then raise exception 'Akses ditolak'; end if;
 perform pg_advisory_xact_lock(hashtextextended(operation_id::text,0));
 select e.ticket into existing from public.service_events e where e.request_id=operation_id and e.actor=auth.uid() and e.event=cmd;
 if found then return existing; end if;
 if cmd='create' then
   if not public.can_service('admin',branch_code) then raise exception 'Akses ditolak'; end if;
   insert into public.tickets(number,intake,location,pickup,customer,phone,device,serial,accessories,complaint,receiver,estimate)
   values(branch_code||'-'||to_char(now() at time zone 'Asia/Makassar','YYYYMMDD')||'-'||nextval('public.service_number'),
     branch_code,branch_code,coalesce(fields->>'pickup',branch_code),trim(fields->>'customer'),coalesce(trim(fields->>'phone'),''),trim(fields->>'device'),
     coalesce(trim(fields->>'serial'),''),coalesce(trim(fields->>'accessories'),''),trim(fields->>'complaint'),
     trim(fields->>'receiver'),(fields->>'estimate')::integer) returning * into t;
 else
   select * into t from public.tickets where id=ticket_id for update;
   if not found or not public.can_read_service(t) then raise exception 'Tiket tidak tersedia'; end if;
   if t.status='Sudah diambil' then raise exception 'Servis sudah diserahkan'; end if;
   if t.status='Dibatalkan' then raise exception 'Servis sudah dibatalkan'; end if;
   case cmd
   when 'assign' then
     if branch_code<>t.location or t.destination is not null or not public.can_service('admin',branch_code) then raise exception 'Akses ditolak'; end if;
     assignee := (fields->>'technician')::uuid;
     if not exists(select 1 from public.staff where user_id=assignee and branch=branch_code and role='technician') then raise exception 'Teknisi tidak terdaftar di cabang ini'; end if;
     update public.tickets set assigned=assignee,technician=trim(fields->>'name') where id=t.id;
   when 'send' then
     target := fields->>'target';
     if branch_code<>t.location or t.destination is not null or not public.can_service('admin',branch_code) then raise exception 'Akses ditolak'; end if;
     if target is null or target=branch_code then raise exception 'Pilih cabang lain'; end if;
     event_detail := target;
     update public.tickets set destination=target,sent_by=auth.uid(),
       status=case when status='Siap diambil' then 'Sedang dikerjakan' else status end where id=t.id;
   when 'receive' then
     if t.destination is distinct from branch_code or not public.can_service('admin',branch_code) then raise exception 'Akses ditolak'; end if;
     event_detail := t.location;
     update public.tickets set location=branch_code,destination=null,sent_by=null,assigned=null where id=t.id;
   when 'work' then
     if branch_code<>t.location or t.destination is not null or not (public.can_service('admin',branch_code)
       or (coalesce(t.assigned=auth.uid(),false) and public.can_service('technician',branch_code))) then raise exception 'Akses ditolak'; end if;
     target := fields->>'status';
     if target is null or target='Sudah diambil' then raise exception 'Status tidak valid'; end if;
     value_num := (fields->>'cost')::integer;
     if target='Siap diambil' and (t.pickup<>branch_code or value_num is null) then raise exception 'Barang harus di cabang pengambilan dan biaya akhir harus diisi'; end if;
     event_detail := target;
     update public.tickets set status=target,cost=value_num,action_taken=coalesce(fields->>'action_taken',''),
       warranty=coalesce((fields->>'warranty')::integer,0) where id=t.id;
   when 'deposit','settlement' then
     if not public.can_service('cashier',branch_code) or (cmd='deposit' and branch_code<>t.intake)
       or (cmd='settlement' and branch_code<>t.pickup) then raise exception 'Akses ditolak'; end if;
     value_num := (fields->>'amount')::integer;
     event_detail := trim(coalesce(fields->>'method',''));
     if value_num is null or value_num<=0 or event_detail='' then raise exception 'Nominal dan metode pembayaran wajib diisi'; end if;
     if cmd='settlement' and t.cost is null then raise exception 'Isi biaya akhir sebelum pelunasan'; end if;
     update public.tickets set deposit=deposit+case when cmd='deposit' then value_num else 0 end,
       settlement=settlement+case when cmd='settlement' then value_num else 0 end,
       method=case when cmd='settlement' then event_detail else method end where id=t.id;
   when 'pickup' then
     if not public.can_service('cashier',branch_code) or branch_code<>t.pickup or branch_code<>t.location or
       t.destination is not null or t.status<>'Siap diambil' then raise exception 'Barang belum siap diserahkan di cabang ini'; end if;
     if t.cost is null or t.cost<>t.deposit+t.settlement then raise exception 'Pembayaran belum lunas'; end if;
     if coalesce(trim(fields->>'handed_by'),'')='' or coalesce(trim(fields->>'picked_by'),'')='' then raise exception 'Nama penyerah dan pengambil wajib diisi'; end if;
     update public.tickets set handed_by=trim(fields->>'handed_by'),picked_by=trim(fields->>'picked_by'),status='Sudah diambil' where id=t.id;
   when 'edit' then
     if branch_code<>t.location or t.destination is not null or not public.can_service('admin',branch_code) then raise exception 'Akses ditolak'; end if;
     -- Kolom yang tidak dikirim tetap; kolom yang dikirim kosong akan ditolak oleh constraint.
     update public.tickets set
       customer=case when fields ? 'customer' then coalesce(trim(fields->>'customer'),'') else customer end,
       phone=case when fields ? 'phone' then coalesce(trim(fields->>'phone'),'') else phone end,
       device=case when fields ? 'device' then coalesce(trim(fields->>'device'),'') else device end,
       serial=case when fields ? 'serial' then coalesce(trim(fields->>'serial'),'') else serial end,
       accessories=case when fields ? 'accessories' then coalesce(trim(fields->>'accessories'),'') else accessories end,
       complaint=case when fields ? 'complaint' then coalesce(trim(fields->>'complaint'),'') else complaint end,
       receiver=case when fields ? 'receiver' then coalesce(trim(fields->>'receiver'),'') else receiver end
     where id=t.id;
     event_detail := 'Data pelanggan';
   when 'cancel' then
     if branch_code<>t.location or t.destination is not null or not public.can_service('admin',branch_code) then raise exception 'Akses ditolak'; end if;
     event_detail := trim(coalesce(fields->>'reason',''));
     if event_detail='' then raise exception 'Alasan pembatalan wajib diisi'; end if;
     paid := t.deposit + t.settlement;
     value_num := coalesce((fields->>'refund')::integer, 0);
     if value_num <> paid then raise exception 'Pengembalian dana harus sama dengan uang yang sudah dibayar'; end if;
     if paid > 0 and trim(coalesce(fields->>'method',''))='' then raise exception 'Metode pengembalian dana wajib diisi'; end if;
     update public.tickets set status='Dibatalkan', refund=value_num where id=t.id;
     if paid > 0 then
       insert into public.service_events(ticket,actor,branch,event,detail,amount)
       values(t.id,auth.uid(),branch_code,'refund',trim(fields->>'method'),paid);
     end if;
   when 'token' then
     if branch_code<>t.location or t.destination is not null or not public.can_service('admin',branch_code) then raise exception 'Akses ditolak'; end if;
     update public.tickets set token=gen_random_uuid() where id=t.id;
     event_detail := 'Tautan pelacakan diganti';
   else raise exception 'Perintah tidak dikenal';
   end case;
 end if;
 insert into public.service_events(ticket,actor,branch,event,detail,amount,request_id)
 values(t.id,auth.uid(),branch_code,cmd,event_detail,case when cmd in ('deposit','settlement') then value_num end,operation_id);
 return t.id;
end $$;

commit;
