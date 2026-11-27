'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import QRCode from 'qrcode';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const db = url && key ? createClient(url, key) : null;
const statuses = ['Belum dicek','Sedang dicek','Menunggu konfirmasi','Menunggu suku cadang','Sedang dikerjakan','Siap diambil'];
const roles = { owner:'Pemilik', admin:'Admin cabang', technician:'Teknisi', cashier:'Kasir' };
const eventNames = { create:'Barang diterima', assign:'Teknisi ditugaskan', send:'Barang dikirim', receive:'Transfer diterima', work:'Status diperbarui', deposit:'Uang muka', settlement:'Pembayaran', pickup:'Barang diserahkan', edit:'Data pelanggan diubah', cancel:'Servis dibatalkan', refund:'Pengembalian dana', token:'Tautan pelacakan diganti' };
const money = n => n == null ? '—' : 'Rp' + Number(n).toLocaleString('id-ID');
const when = v => v ? new Intl.DateTimeFormat('id-ID',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Makassar'}).format(new Date(v))+' WITA' : '—';
function serviceDuration(ticket) {
  const minutes = Math.max(0, Math.floor(((ticket.picked_up_at ? Date.parse(ticket.picked_up_at) : Date.now()) - Date.parse(ticket.created_at)) / 60000));
  if (minutes >= 1440) return Math.floor(minutes / 1440) + ' hari';
  if (minutes >= 60) return Math.floor(minutes / 60) + ' jam';
  return minutes + ' menit';
}

const today = () => new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Makassar'}).format(new Date());
const tracking = token => window.location.origin + '/?lacak=' + token;

// Menerjemahkan error database menjadi pesan yang dapat dipahami petugas.
function friendly(e) {
  const m = e?.message || '';
  if (/violates check constraint|violates not-null constraint/.test(m)) return 'Data tidak valid. Periksa nominal, biaya akhir, dan pembayaran yang sudah tercatat.';
  if (/row-level security|permission denied/i.test(m)) return 'Akses ditolak untuk tindakan ini.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Koneksi ke server gagal. Periksa jaringan lalu coba lagi.';
  return m || 'Operasi gagal.';
}

// Memeriksa aturan pembayaran di sisi aplikasi agar petugas langsung melihat alasannya.
function paymentProblem(t, cmd, fields) {
  if (!t) return '';
  const paid = t.deposit + t.settlement;
  const amount = Number(fields.amount);
  if (cmd === 'deposit' || cmd === 'settlement') {
    if (!(amount > 0)) return 'Nominal pembayaran harus lebih dari nol.';
    if (cmd === 'deposit' && t.cost != null && paid + amount > t.cost) return 'Uang muka melebihi sisa biaya (' + money(t.cost - paid) + ').';
    if (cmd === 'settlement' && t.cost != null && amount > t.cost - paid) return 'Pelunasan melebihi sisa pembayaran (' + money(t.cost - paid) + ').';
  }
  if (cmd === 'work' && fields.cost != null && Number(fields.cost) < paid) return 'Biaya akhir tidak boleh lebih kecil dari yang sudah dibayar (' + money(paid) + ').';
  return '';
}

function Input({ name, label, value, type='text', required=false, maxLength=120 }) {
  return <label>{label}<input name={name} type={type} defaultValue={value ?? ''} required={required}
    maxLength={maxLength} min={type==='number'?0:undefined} step={type==='number'?1:undefined}/></label>;
}
function Select({ name, label, choices, value, required=true }) {
  return <label>{label}<select name={name} defaultValue={value} required={required}>
    {choices.map(([k,v])=><option value={k} key={k}>{v}</option>)}
  </select></label>;
}
function Track({ token }) {
  const [result,setResult] = useState({ loading:true });
  useEffect(()=>{
    let active = true;
    const load = async () => {
      if (!db || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(token)) {
        setResult({error:'Tautan pelacakan tidak tersedia.'}); return;
      }
      const {data,error} = await db.rpc('track_service',{code:token});
      if(active) setResult(error?{error:'Status belum dapat dimuat. Coba lagi.'}:{ticket:data[0]});
    };
    load();
    return ()=>{active=false};
  },[token]);
  const t=result.ticket;
  return <main className="narrow"><section className="panel"><h1>Lacak Servis</h1><p>Makassar Computindo</p>
    {result.loading?<p>Memuat status…</p>:t?<><h2>{t.device}</h2><p>{t.number}</p><p><span className="tag">{t.status}</span></p>
      <p>Pengambilan di Cabang <strong>{t.pickup}</strong></p><p>Terakhir diperbarui {when(t.updated_at)}</p>
      {t.warranty_until && <p>Garansi hingga {t.warranty_until.split('-').reverse().join('/')}</p>}</>:<p role="alert">{result.error || 'Tiket tidak tersedia.'}</p>}
    <button onClick={()=>window.location.reload()}>Muat ulang status</button>
  </section></main>;
}
export default function Service(){
  const params=useSearchParams();
  const token=params.get('lacak');
  return token ? <Track token={token}/> : db ? <Desk initialTicket={params.get('tiket')}/> :
    <main className="narrow"><h1>Makassar Computindo</h1><p>Konfigurasi Supabase belum diisi. Ikuti petunjuk pada README proyek.</p></main>;
}
function Desk({initialTicket}){
  const [session,setSession]=useState(undefined), [members,setMembers]=useState([]);
  const [branches,setBranches]=useState([]), [tickets,setTickets]=useState([]), [events,setEvents]=useState([]);
  const [filter,setFilter]=useState(''), [query,setQuery]=useState(''), [view,setView]=useState('tickets');
  const [selected,setSelected]=useState(null), [creating,setCreating]=useState(false);
  const [technicians,setTechnicians]=useState([]), [cash,setCash]=useState([]), [directory,setDirectory]=useState([]);
  const [error,setError]=useState(''), [busy,setBusy]=useState(false), [print,setPrint]=useState(null);
  const [opening,setOpening]=useState(initialTicket);
  const [myName,setMyName]=useState('');
  const [showPassword,setShowPassword]=useState(false);
  const [queue,setQueue]=useState('all');
  const detail=useRef(null);
  const id=session?.user?.id;
  const ticket=tickets.find(t=>t.id===selected);
  const name=code=>branches.find(b=>b.code===code)?.name || code;
  const can=(role,branch)=>members.some(m=>m.role==='owner'||(m.role===role&&m.branch===branch));
  const owner=members.some(m=>m.role==='owner');
  const branchChoices=branches.map(b=>[b.code,b.name]);
  const hasRole=role=>owner||members.some(m=>m.role===role);

  useEffect(()=>{
    const {data}=db.auth.onAuthStateChange((_,current)=>setSession(current));
    return ()=>data.subscription.unsubscribe();
  },[]);
  useEffect(()=>{
    if(!id)return;
    db.from('profiles').select('display_name').eq('user_id',id).maybeSingle().then(({data})=>setMyName(data?.display_name||''));
  },[id]);
  async function loadTickets(){
    const all=[];
    for(let start=0;;start+=500){
      const {data,error}=await db.from('tickets').select('*').order('created_at',{ascending:false}).order('id').range(start,start+499);
      if(error) throw error;
      all.push(...data);
      if(data.length<500) break;
    }
    return all;
  }
  useEffect(()=>{
    let active=true;
    setMembers([]);setBranches([]);setTickets([]);setSelected(null);setEvents([]);setDirectory([]);setCash([]);
    setView('tickets');setCreating(false);setPrint(null);
    if(id) Promise.all([db.from('staff').select('role,branch').eq('user_id',id),db.from('branches').select('*').order('name'),loadTickets()])
      .then(([staff,units,rows])=>{
        if(!active)return;
        if(staff.error||units.error)throw staff.error||units.error;
        setMembers(staff.data);setBranches(units.data);setTickets(rows);
        if(initialTicket && rows.some(r=>r.id===initialTicket))setSelected(initialTicket);
        if(initialTicket)setOpening(null);
      }).catch(e=>{if(active)setError(e.message)});
    return ()=>{active=false};
  },[id,initialTicket]);
  useEffect(()=>{
    let active=true;
    setEvents([]);setTechnicians([]);
    if(ticket) Promise.all([
      db.from('service_events').select('*').eq('ticket',ticket.id).order('id',{ascending:false}).limit(100),
      db.rpc('branch_technicians',{branch_code:ticket.location}),
    ]).then(([history,techs])=>{
      if(!active)return;
      if(history.error||techs.error){setError((history.error||techs.error).message);return}
      setEvents(history.data);setTechnicians(techs.data);
    });
    return ()=>{active=false};
  },[ticket]);
  useEffect(()=>{
    const dialog=detail.current;
    if(dialog && !dialog.open)dialog.showModal();
  },[ticket?.id,view,creating]);
  function closePrint(){
    setPrint(null);
    detail.current?.showModal();
  }

  async function run(task){
    if(busy)return;
    setBusy(true);setError('');
    try{await task()}catch(e){setError(friendly(e))}
    finally{setBusy(false)}
  }
  function command(e,cmd,branch){
    e.preventDefault();
    const fields=Object.fromEntries(new FormData(e.currentTarget));
    for(const k of Object.keys(fields))if(fields[k]==='')fields[k]=null;
    const form=e.currentTarget;
    const request= formOperation(form,fields);
    return run(async()=>{
      const problem=paymentProblem(ticket,cmd,fields);
      if(problem)throw Error(problem);
      const {data,error}=await db.rpc('service_command',{
        cmd,ticket_id:ticket?.id||null,branch_code:branch||fields.branch,fields,operation_id:request,
      });
      if(error)throw error;
      setSelected(data);setCreating(false);
      const {data:row,error:rowError}=await db.from('tickets').select('*').eq('id',data).single();
      if(rowError)throw rowError;
      setTickets(list=>list.some(t=>t.id===row.id)?list.map(t=>t.id===row.id?row:t):[row,...list]);
      delete form.dataset.operation;
      delete form.dataset.payload;
      if(['deposit','settlement','pickup'].includes(cmd))form.reset();
    });
  }
  function formOperation(form,fields){
    const payload=JSON.stringify(fields);
    if(form.dataset.payload!==payload){
      form.dataset.payload=payload;
      form.dataset.operation=crypto.randomUUID();
    }
    return form.dataset.operation;
  }
  function openStaff(){
    setView('staff');setCreating(false);setSelected(null);
    return run(refreshStaff);
  }
  async function refreshStaff(){
    const {data,error}=await db.rpc('staff_directory');
    if(error)throw error;
    setDirectory(data);
  }
  function roleChange(person,duty,branch,enabled){
    return run(async()=>{
      const {error}=await db.rpc('set_staff_role',{person,duty,branch_code:branch,enabled});
      if(error)throw error;
      await refreshStaff();
    });
  }
  function report(e){
    e.preventDefault();
    const f=new FormData(e.currentTarget);
    const start=new Date(f.get('start')+'T00:00:00+08:00');
    const last=new Date(f.get('end')+'T00:00:00+08:00');
    return run(async()=>{
      if(last<start) throw Error('Tanggal akhir harus sama dengan atau sesudah tanggal awal.');
      const {data,error}=await db.rpc('branch_cash',{branch_code:f.get('branch')||null,start_at:start.toISOString(),until_at:new Date(+last+86400000).toISOString()});
      if(error)throw error;
      setCash(data);
    });
  }
  function preparePrint(kind){
    return run(async()=>{
      const customer=QRCode.create(tracking(ticket.token),{errorCorrectionLevel:'M'}).modules;
      const staff=kind==='receipt' ? QRCode.create(window.location.origin+'/?tiket='+ticket.id,{errorCorrectionLevel:'M'}).modules : null;
      if(detail.current?.open){
        detail.current.dataset.printing='true';
        detail.current.close();
      }
      setPrint({kind,ticket,customer,staff,branch:branches.find(b=>b.code===(kind==='receipt'?ticket.intake:ticket.pickup))});
    });
  }
  if(session===undefined)return <main>Memuat aplikasi…</main>;
  if(!session)return <main className="login"><section className="login-brand"><div className="login-mark" aria-hidden="true">MC</div><strong>MAKASSAR COMPUTINDO</strong><h1>Manajemen servis</h1><p>Cabang Maros dan Makassar</p></section><section className="login-form"><h2>Masuk ke akun petugas</h2><p className="muted">Gunakan email dan kata sandi akun kerja Anda.</p>
    <form className="grid" onSubmit={e=>{
      e.preventDefault();const f=new FormData(e.currentTarget);
      run(async()=>{const {error}=await db.auth.signInWithPassword({email:f.get('email'),password:f.get('password')});if(error)throw error});
    }}><label>Email<input name="email" type="email" autoComplete="username" required placeholder="nama@contoh.com"/></label>
      <label>Kata sandi</label><div className="login-password">
        <input aria-label="Kata sandi" name="password" type={showPassword?'text':'password'} autoComplete="current-password" required/>
        <button type="button" onClick={()=>setShowPassword(v=>!v)}>{showPassword?'Sembunyikan':'Tampilkan'}</button>
      </div>
      <button className="primary" disabled={busy}>{busy?'Sedang masuk…':'Masuk'}</button></form>{error&&<p className="error" role="alert">{error}</p>}
    </section></main>;
  const queues=[
    ['all','Semua servis',()=>true],
    ['work','Proses servis',t=>Boolean(t.destination)||!['Siap diambil','Sudah diambil','Dibatalkan'].includes(t.status)],
    ['ready','Siap diambil',t=>!t.destination&&t.status==='Siap diambil'],
    ['done','Selesai',t=>['Sudah diambil','Dibatalkan'].includes(t.status)],
  ];
  const inQueue=queues.find(([k])=>k===queue)[2];
  const visible=tickets.filter(t=>inQueue(t)&&(!filter||t.intake===filter)&&[t.number,t.customer,t.device].some(s=>s.toLowerCase().includes(query.trim().toLowerCase())));
  const location=ticket?.location, active=ticket && !['Sudah diambil','Dibatalkan'].includes(ticket.status);
  const admin=ticket&&can('admin',location);
  const work=active&&!ticket.destination&&(admin||(ticket.assigned===id&&can('technician',location)));
  return <>
    <div className="service-shell" hidden={Boolean(print)}>
      <aside className="sidebar">
        <div className="sidebar-brand"><strong>Makassar Computindo</strong><span>Manajemen servis</span></div>
        <nav aria-label="Menu petugas">
          {queues.map(([k,label])=><a key={k} href="/" className={view==='tickets'&&queue===k?'active':''}
            onClick={e=>{if(e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();setView('tickets');setQueue(k);setCreating(false);setSelected(null)}}>{label}</a>)}
          {hasRole('cashier')&&<button className={view==='cash'?'active':''} onClick={()=>setView('cash')}>Rekap kas</button>}
          {owner&&<button className={view==='staff'?'active':''} onClick={openStaff}>Akses petugas</button>}
        </nav>
        <button className="sign-out" onClick={()=>run(async()=>{const r=await db.auth.signOut();if(r.error)throw r.error})}>Keluar</button>
      </aside>
    <main className="dashboard">
      <p className="muted">{members.map(m=>roles[m.role]+(m.role==='owner'?'':' '+name(m.branch))).join(' · ') || 'Peran belum tersedia. Hubungi pemilik.'}</p>
      {error&&<p className="panel error" role="alert">{error}</p>}
      {view==='staff'&&owner&&<section className="panel"><h1>Akses petugas</h1><p>Akun login dibuat di Supabase Auth. Tetapkan aksesnya di sini.</p>
        <form className="grid" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);roleChange(f.get('user'),f.get('role'),f.get('branch'),true)}}>
          <Select name="user" label="Akun" choices={[...new Map(directory.map(u=>[u.user_id,u.email])).entries()]}/>
          <Select name="role" label="Peran" choices={Object.entries(roles)}/><Select name="branch" label="Cabang" choices={branchChoices}/>
          <button disabled={busy||!directory.length}>Tambahkan akses</button>
        </form>
        <ul>{directory.filter(u=>u.role).map(u=><li key={u.user_id+u.role+u.branch}>{u.email} · {roles[u.role]} {name(u.branch)} {' '}
          <button disabled={busy||(u.user_id===id&&u.role==='owner')} onClick={()=>roleChange(u.user_id,u.role,u.branch,false)}>Cabut</button></li>)}</ul>
        <h2>Nama petugas</h2><p className="muted">Nama ini dipakai sebagai petugas penerima dan nama teknisi pada tiket.</p>
        {[...new Map(directory.map(u=>[u.user_id,u])).values()].map(u=><form key={u.user_id} className="row" onSubmit={e=>{
          e.preventDefault();const f=new FormData(e.currentTarget);
          run(async()=>{const {error}=await db.rpc('set_display_name',{person:u.user_id,name:f.get('name')});if(error)throw error;if(u.user_id===id)setMyName(String(f.get('name')).trim());await refreshStaff();});
        }}><span>{u.email}</span><input name="name" defaultValue={u.display_name||''} maxLength={80} placeholder="Nama tampilan" required/><button disabled={busy}>Simpan nama</button></form>)}
      </section>}
      {view==='cash'&&hasRole('cashier')&&<section className="panel"><h1>Rekap kas</h1>
        <form className="grid" onSubmit={report}>
          <Input name="start" label="Tanggal mulai (WITA)" type="date" value={today()} required/>
          <Input name="end" label="Tanggal akhir (WITA)" type="date" value={today()} required/>
          <label>Cabang<select name="branch"><option value="">Semua cabang yang diizinkan</option>{branchChoices.filter(([b])=>can('cashier',b)).map(([b,n])=><option key={b} value={b}>{n}</option>)}</select></label>
          <button disabled={busy}>Tampilkan</button>
        </form>
        {cash.length?<ul>{cash.map(r=><li key={r.branch+r.event}>{name(r.branch)} · {eventNames[r.event]} · {money(r.amount)} ({r.transactions} transaksi)</li>)}</ul>:<p>Belum ada transaksi untuk ditampilkan.</p>}
      </section>}
      {view==='tickets'&&creating&&<section className="panel"><h1>Terima servis</h1>
        <form className="grid" onSubmit={e=>command(e,'create')}>
          <Select name="branch" label="Cabang penerimaan" choices={branchChoices.filter(([b])=>can('admin',b))}/>
          <label>Petugas penerima<input readOnly value={myName||'Nama belum diatur di Akses petugas'}/></label>
          <Select name="pickup" required={false} label="Cabang pengambilan" choices={[["","Sama dengan cabang penerimaan"],...branchChoices]}/>
          <Input name="customer" label="Pelanggan" required maxLength={100}/><Input name="phone" label="WhatsApp" type="tel"/>
          <Input name="device" label="Perangkat / model" required/><Input name="serial" label="Nomor seri"/>
          <Input name="accessories" label="Kelengkapan"/><Input name="estimate" label="Estimasi biaya (Rp)" type="number"/>
          <label className="wide">Keluhan<textarea name="complaint" required maxLength={400}/></label>
          <button className="primary" disabled={busy}>Simpan tiket</button><button type="button" onClick={()=>setCreating(false)}>Batal</button>
        </form></section>}
      {view==='tickets'&&!creating&&<section className="panel">
        <div className="row between"><h1>{queues.find(([k])=>queue===k)[1]}</h1>{hasRole('admin')&&<button className="primary" onClick={()=>setCreating(true)}>Terima servis</button>}</div>
        <div className="queue-cards">{queues.map(([k,label,match])=><button key={k} className={queue===k?'queue-active':''} onClick={()=>setQueue(k)}>
          {label}<strong>{tickets.filter(t=>(!filter||t.intake===filter)&&match(t)).length}</strong></button>)}</div>
        <div className="row"><input aria-label="Cari servis" placeholder="Cari tiket, pelanggan, perangkat" value={query} onChange={e=>setQuery(e.target.value)}/>
          <select aria-label="Cabang penerimaan" value={filter} onChange={e=>setFilter(e.target.value)}><option value="">Semua cabang penerimaan</option>
            {branchChoices.map(([b,n])=><option value={b} key={b}>{n}</option>)}</select>
          <button disabled={busy} onClick={()=>run(async()=>setTickets(await loadTickets()))}>Muat ulang</button>
        </div>
        {initialTicket&&!opening&& !tickets.some(t=>t.id===initialTicket)&&<p>Tiket dari tautan tidak tersedia untuk akun ini.</p>}
        <div className="scroll"><table><thead><tr><th>Tiket / pelanggan</th><th>WhatsApp</th><th>Barang</th><th>Diterima</th><th>Lokasi barang</th><th>Ambil di</th><th>Status</th><th>Durasi</th><th>Aksi</th></tr></thead>
          <tbody>{visible.map(t=><tr key={t.id}><td><a className="ticket-link" href={'/?tiket='+t.id} onClick={e=>{
              if(e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
              e.preventDefault();setSelected(t.id);
            }}>{t.number}</a><br/>{t.customer}</td><td>{t.phone||'—'}</td><td>{t.device}</td><td>{name(t.intake)}</td>
            <td>{name(t.location)}{t.destination&&' → '+name(t.destination)}</td><td>{name(t.pickup)}</td>
            <td><span className="tag">{t.destination?'Dalam perjalanan':t.status}</span></td><td className="duration">{serviceDuration(t)}</td><td><button onClick={()=>setSelected(t.id)}>Detail</button></td></tr>)}
          {!visible.length&&<tr><td colSpan="9">Tidak ada tiket yang ditampilkan.</td></tr>}</tbody></table></div>
      </section>}
      {view==='tickets'&&ticket&&!creating&&<dialog ref={detail} aria-labelledby="ticket-title" onClose={e=>{if(e.currentTarget.dataset.printing){delete e.currentTarget.dataset.printing;return}setSelected(null)}}><article key={ticket.id+ticket.updated_at}>
        <section className="panel"><div className="row between"><h2 id="ticket-title">Servis {ticket.number}</h2><button onClick={()=>detail.current?.close()}>Tutup</button></div>
          {error&&<p className="error" role="alert">{error}</p>}
          <p className="muted">Diterima {when(ticket.created_at)} · {name(ticket.intake)} · Ambil di {name(ticket.pickup)}</p>
          <p><span className="tag">{ticket.destination?'Dalam perjalanan':ticket.status}</span> · Barang di {name(location)}{ticket.destination&&' → '+name(ticket.destination)}</p>
          <div className="grid ticket-fields">
            <label>Nama pelanggan<input readOnly value={ticket.customer}/></label>
            <label>Nomor WhatsApp<input readOnly value={ticket.phone}/></label>
            <label>Perangkat<input readOnly value={ticket.device}/></label>
            <label>Kelengkapan<input readOnly value={ticket.accessories}/></label>
            <label className="wide">Keluhan<textarea readOnly value={ticket.complaint}/></label>
            <label>Penerima<input readOnly value={ticket.receiver}/></label>
            {active&&admin&&!ticket.destination ?
              <form onSubmit={e=>command(e,'assign',location)}>
                <Select name="technician" label="Teknisi" choices={[
                  ['', 'Pilih teknisi'],
                  ...technicians.map(t=>[t.user_id,t.display_name||'(belum ada nama)']),
                ]} value={technicians.some(t=>t.user_id===ticket.assigned)?ticket.assigned:''} key={technicians.map(t=>t.user_id).join(',')}/>
                {technicians.length>0 ? <button className="assign-button" disabled={busy}>Simpan teknisi</button> :
                  <small>Jika daftar kosong, tambahkan peran Teknisi di cabang {name(location)} melalui Akses petugas.</small>}
              </form> :
              <label>Teknisi<input readOnly value={ticket.technician||'Belum ditugaskan'}/></label>}
          </div>
          <form className="grid ticket-fields" onSubmit={e=>command(e,'work',location)}>
            {work?<><Select name="status" label="Status servis" value={ticket.status} choices={statuses.map(s=>[s,s])}/>
            <Input name="warranty" label="Garansi (hari)" type="number" value={ticket.warranty}/>
            <Input name="cost" label="Biaya akhir (Rp)" type="number" value={ticket.cost}/></>:
            <><label>Status servis<input readOnly value={ticket.status}/></label><label>Garansi (hari)<input readOnly value={ticket.warranty}/></label>
            <label>Biaya akhir (Rp)<input readOnly value={ticket.cost??''}/></label></>}
            <label>Total sudah dibayar (Rp)<input readOnly value={ticket.deposit+ticket.settlement}/></label>
            {ticket.refund>0&&<label>Dikembalikan (Rp)<input readOnly value={ticket.refund}/></label>}
            {work?<><label className="wide">Hasil pemeriksaan dan tindakan<textarea name="action_taken" defaultValue={ticket.action_taken} maxLength={500}/></label>
            <div className="wide"><button className="primary" disabled={busy}>Simpan pengerjaan</button></div></>:
            ticket.action_taken&&<label className="wide">Hasil pemeriksaan dan tindakan<textarea readOnly value={ticket.action_taken}/></label>}
          </form>
          <div className="row">
            <a className="button" href={tracking(ticket.token)} target="_blank" rel="noreferrer">Lacak servis</a>
            {ticket.phone&&<a className="button" href={'https://wa.me/'+ticket.phone.replace(/\D/g,'').replace(/^0/,'62')+'?text='+encodeURIComponent('Halo, lacak servis '+ticket.number+' di '+tracking(ticket.token))} target="_blank" rel="noreferrer">Bagikan lewat WhatsApp</a>}
            {(can('admin',ticket.intake)||can('cashier',ticket.intake))&&<button disabled={busy} onClick={()=>preparePrint('receipt')}>Cetak tanda terima A4</button>}
            {(can('admin',ticket.pickup)||can('cashier',ticket.pickup))&&
              <button disabled={busy||ticket.cost===null||ticket.status==='Dibatalkan'} onClick={()=>preparePrint('invoice')}>Cetak nota servis A4</button>}
          </div>
          {ticket.cost===null&&(can('admin',ticket.pickup)||can('cashier',ticket.pickup))&&
            <small>Isi dan simpan biaya akhir untuk mencetak nota servis.</small>}
        </section>
        {active&&admin&&!ticket.destination&&<section className="panel"><h2>Transfer antar-cabang</h2>
          <form className="row" onSubmit={e=>command(e,'send',location)}><Select name="target" label="Kirim ke cabang" choices={branchChoices.filter(([b])=>b!==location)}/><button disabled={busy}>Kirim barang</button></form>
        </section>}
        {active&&ticket.destination&&can('admin',ticket.destination)&&<section className="panel"><form onSubmit={e=>command(e,'receive',ticket.destination)}><button disabled={busy}>Konfirmasi terima di {name(ticket.destination)}</button></form></section>}
        {active&&[['deposit',ticket.intake],['settlement',ticket.pickup]].filter(([cmd,b])=>can('cashier',b)&&(cmd==='deposit'||ticket.cost!==null)).map(([cmd,b])=>
          <section className="panel" key={cmd}><h2>{eventNames[cmd]} · {name(b)}</h2><form className="row" onSubmit={e=>command(e,cmd,b)}>
            <Input name="amount" label="Nominal (Rp)" type="number" required/>
            <Select name="method" label="Metode" choices={['Tunai','QRIS','Transfer','Kartu'].map(m=>[m,m])}/><button disabled={busy}>Catat pembayaran</button>
          </form></section>)}
        {active&&ticket.status==='Siap diambil'&&can('cashier',ticket.pickup)&&<section className="panel"><h2>Penyerahan barang</h2>
          <form className="row" onSubmit={e=>command(e,'pickup',ticket.pickup)}>
            <Input name="handed_by" label="Nama penyerah" required/><Input name="picked_by" label="Nama pengambil" required/><button disabled={busy}>Serahkan barang</button></form>
        </section>}
        {active&&admin&&!ticket.destination&&<section className="panel"><h2>Ubah data pelanggan</h2>
          <form className="grid" onSubmit={e=>command(e,'edit',location)}>
            <Input name="customer" label="Nama pelanggan" value={ticket.customer} required maxLength={100}/>
            <Input name="phone" label="WhatsApp" type="tel" value={ticket.phone}/>
            <Input name="device" label="Perangkat / model" value={ticket.device} required/>
            <Input name="serial" label="Nomor seri" value={ticket.serial}/>
            <Input name="accessories" label="Kelengkapan" value={ticket.accessories}/>
            <Input name="receiver" label="Petugas penerima" value={ticket.receiver} required maxLength={80}/>
            <label className="wide">Keluhan<textarea name="complaint" defaultValue={ticket.complaint} required maxLength={400}/></label>
            <div className="wide"><button className="primary" disabled={busy}>Simpan data pelanggan</button></div>
          </form></section>}
        {active&&admin&&!ticket.destination&&<section className="panel"><h2>Tautan pelacakan</h2>
          <p className="muted">Ganti tautan jika tanda terima lama hilang atau tersebar. Tautan dan QR lama tidak lagi bisa dibuka, jadi cetak ulang tanda terima.</p>
          <form className="row" onSubmit={e=>command(e,'token',location)}><button disabled={busy}>Ganti tautan pelacakan</button></form></section>}
        {active&&admin&&!ticket.destination&&<section className="panel"><h2>Batalkan servis</h2>
          <p className="muted">Pembatalan menutup tiket. Pengembalian dana harus sama dengan uang yang sudah dibayar.</p>
          <form className="grid" onSubmit={e=>command(e,'cancel',location)}>
            <Input name="reason" label="Alasan pembatalan" required maxLength={200}/>
            <Input name="refund" label="Pengembalian dana (Rp)" type="number" value={ticket.deposit+ticket.settlement}/>
            {ticket.deposit+ticket.settlement>0&&<Select name="method" label="Metode pengembalian" choices={['Tunai','QRIS','Transfer','Kartu'].map(m=>[m,m])}/>}
            <div className="wide"><button className="primary" disabled={busy}>Batalkan servis</button></div>
          </form></section>}
        <section className="panel"><h2>Riwayat tiket</h2><ul>{events.map(e=><li key={e.id}>{when(e.at)} · {name(e.branch)} · {eventNames[e.event]} {e.detail&&'· '+name(e.detail)} {e.amount&&'· '+money(e.amount)}</li>)}</ul></section>
      </article></dialog>}
    </main></div>
    {print&&<>
      <div className="print-controls row">
        <button onClick={closePrint}>Kembali ke tiket</button>
        <button className="primary" onClick={()=>window.print()}>Cetak / Simpan PDF</button>
      </div>
      <PrintSheet {...print} pickupName={name(print.ticket.pickup)}/>
    </>}
  </>;
}
// Dua pasang kolom per baris agar nota muat di A5 landscape.
function pairRows(list){const rows=[];for(let i=0;i<list.length;i+=2)rows.push([list[i],list[i+1]]);return rows;}
function PrintSheet({kind,ticket:t,branch,staff,customer,pickupName}){
  const receipt=kind==='receipt';
  const booking=[['Perangkat',t.device],['Nomor seri',t.serial],['Kelengkapan',t.accessories],['Keluhan',t.complaint]];
  const remaining=t.cost-t.deposit-t.settlement;
  const data=receipt?[...booking,['Estimasi biaya',money(t.estimate)],['DP diterima',money(t.deposit)]]:
    [...booking,['Tindakan',t.action_taken],['Total servis',money(t.cost)],['Uang muka',money(t.deposit)],
     ['Pembayaran setelah DP',money(t.settlement)],['Metode pembayaran terakhir',t.method],['Sisa pembayaran',remaining>0?money(remaining)+' · BELUM LUNAS':'Rp0 · LUNAS'],['Garansi',t.warranty?t.warranty+' hari sejak barang diambil':'Tidak ada']];
  return <div className="print-sheet">
    <div className="print-head"><div><strong>MAKASSAR COMPUTINDO</strong><p>Cabang {branch?.name}<br/>{branch?.address}<br/>{branch?.phone}</p></div>
      <div><h1>{receipt?'Tanda Terima Servis':'Nota Servis'}</h1><strong>{t.number}</strong></div></div>
    <p>Pelanggan <strong>{t.customer}</strong> {t.phone&&'· '+t.phone.replace(/.(?=.{4})/g,'*')}</p>
    <p>Diterima {when(t.created_at)}{!receipt&&t.picked_up_at&&' · Diambil '+when(t.picked_up_at)}</p>
    <div className="print-body"><table className="print-pairs"><tbody>{pairRows(data).map(([a,b],i)=><tr key={i}><th scope="row">{a[0]}</th><td>{a[1]||'—'}</td><th scope="row">{b?.[0]||''}</th><td>{b?.[1]||''}</td></tr>)}</tbody></table>
    <section className="print-qr">{staff&&<div><PrintQr modules={staff} label="QR petugas"/>Buka tiket petugas</div>}
      <div><PrintQr modules={customer} label="QR pelanggan"/>{receipt?'Lacak servis':'Lihat status dan garansi'}</div></section></div>
    {receipt&&<p>Bawa tanda terima ini saat pengambilan di Cabang {pickupName}.</p>}
    <section className="signatures"><span>{receipt?'Penerima · '+t.receiver:'Penyerah · '+(t.handed_by||'________________')}</span>
      <span>{receipt?'Pelanggan · '+t.customer:'Pengambil · '+(t.picked_by||'________________')}</span></section>
  </div>;
}

function PrintQr({modules,label}){
  const size=modules.size+8;
  const marks=Array.from(modules.data,(filled,i)=>filled
    ? 'M'+(i%modules.size+4)+' '+(Math.floor(i/modules.size)+4)+'h1v1h-1z' : '').join('');
  return <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
    <rect width={size} height={size} fill="#fff"/>
    <path d={marks} fill="#000"/>
  </svg>;
}
