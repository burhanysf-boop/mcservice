begin;
create table public.branches (
 code text primary key, name text not null, address text not null default '', phone text not null default ''
);
insert into public.branches values ('MRS','Maros','Jl. Poros Makassar Maros Km. 21, Kab. Maros','08114450042'),('MKS','Makassar','','');
alter table public.staff add column role text not null default 'owner' check(role in ('owner','admin','technician','cashier'));
alter table public.staff add column branch text not null default 'MRS' references public.branches;
alter table public.staff drop constraint staff_pkey, add primary key(user_id,role,branch);
alter table public.staff alter column role drop default, alter column branch drop default;
alter table public.tickets
 add column intake text not null default 'MRS' references public.branches,
 add column location text not null default 'MRS' references public.branches,
 add column pickup text not null default 'MRS' references public.branches,
 add column destination text references public.branches,
 add column assigned uuid references auth.users,
 add column sent_by uuid references auth.users;
create table public.service_events (
 id bigint generated always as identity primary key,
 ticket uuid not null references public.tickets,
 actor uuid not null references auth.users,
 branch text not null references public.branches,
 event text not null,
 detail text not null default '',
 amount integer,
 request_id uuid unique,
 at timestamptz not null default now()
);
alter table public.branches enable row level security;
alter table public.service_events enable row level security;
create policy branch_read on public.branches for select to authenticated using (true);
revoke all on public.branches,public.service_events from anon,authenticated;
grant select on public.branches,public.service_events to authenticated;

create function public.can_service(wanted text, branch_code text) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 select exists(select 1 from public.staff s where s.user_id=auth.uid() and
 (s.role='owner' or (s.role=wanted and s.branch=branch_code)))
$$;
create function public.can_read_service(t public.tickets) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 select public.can_service('admin',t.intake) or public.can_service('admin',t.location)
 or public.can_service('admin',t.destination) or public.can_service('cashier',t.intake)
 or public.can_service('cashier',t.pickup)
 or (coalesce(t.assigned=auth.uid(),false) and public.can_service('technician',t.location))
$$;
drop policy read_tickets on public.tickets;
drop policy create_tickets on public.tickets;
drop policy edit_tickets on public.tickets;
drop policy read_history on public.ticket_history;
create policy scoped_tickets on public.tickets for select to authenticated using (public.can_read_service(tickets));
create policy scoped_events on public.service_events for select to authenticated using (
 exists(select 1 from public.tickets t where t.id=ticket));
revoke insert (customer,phone,device,serial,accessories,complaint,receiver,technician,action_taken,status,estimate,cost,deposit,settlement,method,warranty,handed_by,picked_by),
 update (customer,phone,device,serial,accessories,complaint,receiver,technician,action_taken,status,estimate,cost,deposit,settlement,method,warranty,handed_by,picked_by)
 on public.tickets from authenticated;

create function public.service_command(cmd text, ticket_id uuid, branch_code text, fields jsonb, operation_id uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare
 t public.tickets%rowtype;
 target text;
 value_num integer;
 assignee uuid;
 existing uuid;
 event_detail text := '';
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
   else raise exception 'Perintah tidak dikenal';
   end case;
 end if;
 insert into public.service_events(ticket,actor,branch,event,detail,amount,request_id)
 values(t.id,auth.uid(),branch_code,cmd,event_detail,case when cmd in ('deposit','settlement') then value_num end,operation_id);
 return t.id;
end $$;

create function public.branch_cash(branch_code text, start_at timestamptz, until_at timestamptz)
returns table(branch text, event text, amount bigint, transactions bigint)
language sql stable security definer set search_path=pg_catalog as $$
 select e.branch,e.event,sum(e.amount),count(*) from public.service_events e where e.amount is not null
 and (branch_code is null or e.branch=branch_code) and public.can_service('cashier',e.branch)
 and e.at>=start_at and e.at<until_at group by e.branch,e.event
$$;
drop function public.track_service(uuid);
create function public.track_service(code uuid)
returns table(number text,device text,status text,pickup text,updated_at timestamptz,warranty_until date)
language sql stable security definer set search_path=pg_catalog as $$
 select t.number,t.device,case when t.destination is not null then 'Dalam perjalanan antar-cabang' else t.status end,
 b.name,t.updated_at,case when t.warranty>0 then (t.picked_up_at at time zone 'Asia/Makassar')::date+t.warranty end
 from public.tickets t join public.branches b on b.code=t.pickup where t.token=$1
$$;
create function public.branch_technicians(branch_code text)
returns table(user_id uuid, email text) language sql stable security definer set search_path=pg_catalog as $$
 select s.user_id,u.email::text from public.staff s join auth.users u on u.id=s.user_id
 where s.branch=branch_code and s.role='technician' and public.can_service('admin',branch_code)
$$;
create function public.staff_directory()
returns table(user_id uuid,email text,role text,branch text) language sql stable security definer set search_path=pg_catalog as $$
 select u.id,u.email::text,s.role,s.branch from auth.users u left join public.staff s on s.user_id=u.id
 where public.can_service('owner','') and exists(select 1 from public.staff a where a.user_id=auth.uid() and a.role='owner')
 order by u.email,s.role,s.branch
$$;
create function public.set_staff_role(person uuid, duty text, branch_code text, enabled boolean)
returns void language plpgsql security definer set search_path=pg_catalog as $$
begin
 if not exists(select 1 from public.staff where user_id=auth.uid() and role='owner') then raise exception 'Akses ditolak'; end if;
 if not enabled and person=auth.uid() and duty='owner' then raise exception 'Peran pemilik sendiri tidak dapat dihapus'; end if;
 if enabled then insert into public.staff values(person,duty,branch_code) on conflict do nothing;
 else delete from public.staff where user_id=person and role=duty and branch=branch_code; end if;
end $$;
revoke all on function public.can_service(text,text),public.can_read_service(public.tickets),
 public.service_command(text,uuid,text,jsonb,uuid),public.track_service(uuid),public.branch_cash(text,timestamptz,timestamptz),
 public.branch_technicians(text),public.staff_directory(),public.set_staff_role(uuid,text,text,boolean) from public,anon,authenticated;
grant execute on function public.can_service(text,text),public.can_read_service(public.tickets),
 public.service_command(text,uuid,text,jsonb,uuid),public.branch_cash(text,timestamptz,timestamptz),
 public.branch_technicians(text),public.staff_directory(),public.set_staff_role(uuid,text,text,boolean) to authenticated;
grant execute on function public.track_service(uuid) to anon,authenticated;
commit;
