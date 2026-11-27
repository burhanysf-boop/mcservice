begin;

-- Nama tampilan setiap petugas. Diatur pemilik di Akses petugas (atau oleh pengguna itu sendiri).
create table public.profiles (
 user_id uuid primary key references auth.users(id) on delete cascade,
 display_name text not null check (length(trim(display_name)) between 1 and 80)
);
alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
create policy own_profile on public.profiles for select to authenticated using (user_id = (select auth.uid()));

create function public.set_display_name(person uuid, name text) returns void
language plpgsql security definer set search_path=pg_catalog as $$
declare clean text := trim(coalesce(name,''));
begin
 if auth.uid() is null then raise exception 'Akses ditolak'; end if;
 if person<>auth.uid() and not exists(select 1 from public.staff where user_id=auth.uid() and role='owner') then raise exception 'Akses ditolak'; end if;
 if length(clean) < 1 or length(clean) > 80 then raise exception 'Nama wajib diisi (maksimal 80 karakter)'; end if;
 insert into public.profiles(user_id,display_name) values(person,clean)
 on conflict (user_id) do update set display_name=excluded.display_name;
end $$;

-- Petugas penerima dan teknisi diisi dari profil di server, tidak dari input klien.
create function public.set_ticket_people() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if tg_op='INSERT' then
   new.receiver := coalesce((select p.display_name from public.profiles p where p.user_id=auth.uid()),'');
   if new.receiver='' then raise exception 'Nama petugas belum diatur. Minta pemilik mengatur nama di Akses petugas.'; end if;
 end if;
 if tg_op='INSERT' or new.assigned is distinct from old.assigned then
   if new.assigned is null then
     new.technician := '';
   else
     new.technician := coalesce((select p.display_name from public.profiles p where p.user_id=new.assigned),'');
     if new.technician='' then raise exception 'Nama teknisi belum diatur. Minta pemilik mengatur nama di Akses petugas.'; end if;
   end if;
 end if;
 return new;
end $$;
create trigger ticket_people before insert or update of assigned on public.tickets
 for each row execute function public.set_ticket_people();

-- Daftar teknisi dan direktori akun kini menyertakan nama tampilan.
drop function public.branch_technicians(text);
create function public.branch_technicians(branch_code text)
returns table(user_id uuid, display_name text) language sql stable security definer set search_path=pg_catalog as $$
 select s.user_id, coalesce(p.display_name,'') from public.staff s left join public.profiles p on p.user_id=s.user_id
 where s.branch=branch_code and s.role='technician' and public.can_service('admin',branch_code)
$$;

drop function public.staff_directory();
create function public.staff_directory()
returns table(user_id uuid,email text,role text,branch text,display_name text) language sql stable security definer set search_path=pg_catalog as $$
 select u.id,u.email::text,s.role,s.branch,p.display_name from auth.users u
 left join public.staff s on s.user_id=u.id left join public.profiles p on p.user_id=u.id
 where public.can_service('owner','') and exists(select 1 from public.staff a where a.user_id=auth.uid() and a.role='owner')
 order by u.email,s.role,s.branch
$$;

revoke all on function public.set_display_name(uuid,text), public.set_ticket_people(),
 public.branch_technicians(text), public.staff_directory() from public, anon, authenticated;
grant execute on function public.set_display_name(uuid,text), public.branch_technicians(text), public.staff_directory() to authenticated;

commit;
