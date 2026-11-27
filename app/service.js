'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import QRCode from 'qrcode';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const db = url && key ? createClient(url, key) : null;
const statuses = ['Belum dicek','Sedang dicek','Menunggu konfirmasi','Menunggu suku cadang','Sedang dikerjakan','Siap diambil'];
const roles = { owner:'Pemilik', admin:'Admin cabang', technician:'Teknisi', cashier:'Kasir' };
const eventNames = { create:'Barang diterima', assign:'Teknisi ditugaskan', send:'Barang dikirim', receive:'Transfer diterima', work:'Status diperbarui', deposit:'Uang muka', settlement:'Pembayaran', pickup:'Barang diserahkan' };
const money = n => n == null ? '—' : 'Rp' + Number(n).toLocaleString('id-ID');
const when = v => v ? new Intl.DateTimeFormat('id-ID',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Makassar'}).format(new Date(v))+' WITA' : '—';
const today = () => new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Makassar'}).format(new Date());
const tracking = token => window.location.origin + '/?lacak=' + token;

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
  useEffect(()=>{if(print)window.print()},[print]);

  async function run(task){
    if(busy)return;
    setBusy(true);setError('');
    try{await task()}catch(e){setError(e.message || 'Operasi gagal.')}
    finally{setBusy(false)}
  }
  function command(e,cmd,branch){
    e.preventDefault();
    const fields=Object.fromEntries(new FormData(e.currentTarget));
    for(const k of Object.keys(fields))if(fields[k]==='')fields[k]=null;
    if(cmd==='assign')fields.name=technicians.find(t=>t.user_id===fields.technician)?.email;
    const form=e.currentTarget;
    const request= formOperation(form,fields);
    return run(async()=>{
      const {data,error}=await db.rpc('service_command',{
        cmd,ticket_id:ticket?.id||null,branch_code:branch||fields.branch,fields,operation_id:request,
      });
      if(error)throw error;
      setSelected(data);setCreating(false);
      setTickets(await loadTickets());
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
      const customer=await QRCode.toDataURL(tracking(ticket.token),{errorCorrectionLevel:'M',margin:4});
      const staff=kind==='receipt' ? await QRCode.toDataURL(window.location.origin+'/?tiket='+ticket.id,{errorCorrectionLevel:'M',margin:4}) : null;
      setPrint({kind,ticket,customer,staff,branch:branches.find(b=>b.code===(kind==='receipt'?ticket.intake:ticket.pickup))});
    });
  }
  if(session===undefined)return <main>Memuat aplikasi…</main>;
  if(!session)return <main className="narrow"><section className="panel"><h1>Makassar Computindo</h1><p>Masuk dengan akun petugas.</p>
    <form className="grid" onSubmit={e=>{
      e.preventDefault();const f=new FormData(e.currentTarget);
      run(async()=>{const {error}=await db.auth.signInWithPassword({email:f.get('email'),password:f.get('password')});if(error)throw error});
    }}><Input name="email" label="Email" type="email" required/><Input name="password" label="Kata sandi" type="password" required/>
      <button className="primary" disabled={busy}>Masuk</button></form>{error&&<p className="error" role="alert">{error}</p>}
    </section></main>;
  const visible=tickets.filter(t=>(!filter||t.intake===filter)&&[t.number,t.customer,t.device].some(s=>s.toLowerCase().includes(query.trim().toLowerCase())));
  const location=ticket?.location, active=ticket && ticket.status!=='Sudah diambil';
  const admin=ticket&&can('admin',location);
  const work=active&&!ticket.destination&&(admin||(ticket.assigned===id&&can('technician',location)));
  return <>
    <header><strong>Makassar Computindo · Servis</strong><button onClick={()=>run(async()=>{const r=await db.auth.signOut();if(r.error)throw r.error})}>Keluar</button></header>
    <main className="dashboard">
      <nav className="row">
        <button className={view==='tickets'?'active':''} onClick={()=>{setView('tickets');setCreating(false);setSelected(null)}}>Tiket servis</button>
        {hasRole('cashier')&&<button className={view==='cash'?'active':''} onClick={()=>setView('cash')}>Rekap kas</button>}
        {owner&&<button className={view==='staff'?'active':''} onClick={openStaff}>Akses petugas</button>}
      </nav>
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
          <Input name="receiver" label="Petugas penerima" required maxLength={80}/>
          <Select name="pickup" required={false} label="Cabang pengambilan" choices={[["","Sama dengan cabang penerimaan"],...branchChoices]}/>
          <Input name="customer" label="Pelanggan" required maxLength={100}/><Input name="phone" label="WhatsApp" type="tel"/>
          <Input name="device" label="Perangkat / model" required/><Input name="serial" label="Nomor seri"/>
          <Input name="accessories" label="Kelengkapan"/><Input name="estimate" label="Estimasi biaya (Rp)" type="number"/>
          <label className="wide">Keluhan<textarea name="complaint" required maxLength={400}/></label>
          <button className="primary" disabled={busy}>Simpan tiket</button><button type="button" onClick={()=>setCreating(false)}>Batal</button>
        </form></section>}
      {view==='tickets'&&!creating&&!ticket&&<section className="panel">
        <div className="row between"><h1>Antrean servis</h1>{hasRole('admin')&&<button className="primary" onClick={()=>setCreating(true)}>Terima servis</button>}</div>
        <div className="row"><input aria-label="Cari servis" placeholder="Cari tiket, pelanggan, perangkat" value={query} onChange={e=>setQuery(e.target.value)}/>
          <select aria-label="Cabang penerimaan" value={filter} onChange={e=>setFilter(e.target.value)}><option value="">Semua cabang penerimaan</option>
            {branchChoices.map(([b,n])=><option value={b} key={b}>{n}</option>)}</select>
          <button disabled={busy} onClick={()=>run(async()=>setTickets(await loadTickets()))}>Muat ulang</button>
        </div>
        {initialTicket&&!opening&& !tickets.some(t=>t.id===initialTicket)&&<p>Tiket dari tautan tidak tersedia untuk akun ini.</p>}
        <div className="scroll"><table><thead><tr><th>Tiket / pelanggan</th><th>Barang</th><th>Diterima</th><th>Lokasi barang</th><th>Ambil di</th><th>Status</th><th>Aksi</th></tr></thead>
          <tbody>{visible.map(t=><tr key={t.id}><td><strong>{t.number}</strong><br/>{t.customer}</td><td>{t.device}</td><td>{name(t.intake)}</td>
            <td>{name(t.location)}{t.destination&&' → '+name(t.destination)}</td><td>{name(t.pickup)}</td>
            <td><span className="tag">{t.destination?'Dalam perjalanan':t.status}</span></td><td><button onClick={()=>setSelected(t.id)}>Detail</button></td></tr>)}
          {!visible.length&&<tr><td colSpan="7">Tidak ada tiket yang ditampilkan.</td></tr>}</tbody></table></div>
      </section>}
      {view==='tickets'&&ticket&&!creating&&<article key={ticket.id+ticket.updated_at}>
        <section className="panel"><div className="row between"><h1>{ticket.number}</h1><button onClick={()=>setSelected(null)}>Kembali</button></div>
          <p><strong>{ticket.device}</strong> · {ticket.customer} · {when(ticket.created_at)}</p>
          <p>{ticket.complaint}</p><p>Diterima {name(ticket.intake)} · Barang di {name(location)}{ticket.destination&&' → '+name(ticket.destination)} · Ambil di {name(ticket.pickup)}</p>
          <p><span className="tag">{ticket.destination?'Dalam perjalanan':ticket.status}</span> · Teknisi {ticket.technician||'Belum ditugaskan'}</p>
          <p>Biaya {money(ticket.cost)} · DP {money(ticket.deposit)} · Dibayar setelah DP {money(ticket.settlement)}</p>
          <div className="row">
            <a className="button" href={tracking(ticket.token)} target="_blank" rel="noreferrer">Lacak servis</a>
            {ticket.phone&&<a className="button" href={'https://wa.me/'+ticket.phone.replace(/\D/g,'').replace(/^0/,'62')+'?text='+encodeURIComponent('Halo, lacak servis '+ticket.number+' di '+tracking(ticket.token))} target="_blank" rel="noreferrer">Bagikan lewat WhatsApp</a>}
            {(can('admin',ticket.intake)||can('cashier',ticket.intake))&&<button disabled={busy} onClick={()=>preparePrint('receipt')}>Cetak tanda terima A4</button>}
            {ticket.picked_up_at&&(can('admin',ticket.pickup)||can('cashier',ticket.pickup))&&<button disabled={busy} onClick={()=>preparePrint('invoice')}>Cetak nota A4</button>}
          </div></section>
        {active&&admin&&!ticket.destination&&<section className="panel"><h2>Penugasan dan transfer</h2>
          {technicians.length>0&&<form className="row" onSubmit={e=>command(e,'assign',location)}>
            <Select name="technician" label="Teknisi" choices={technicians.map(t=>[t.user_id,t.email])} value={ticket.assigned}/><button disabled={busy}>Tugaskan</button></form>}
          <form className="row" onSubmit={e=>command(e,'send',location)}><Select name="target" label="Kirim ke cabang" choices={branchChoices.filter(([b])=>b!==location)}/><button disabled={busy}>Kirim barang</button></form>
        </section>}
        {active&&ticket.destination&&can('admin',ticket.destination)&&<section className="panel"><form onSubmit={e=>command(e,'receive',ticket.destination)}><button disabled={busy}>Konfirmasi terima di {name(ticket.destination)}</button></form></section>}
        {work&&<section className="panel"><h2>Pengerjaan</h2><form className="grid" onSubmit={e=>command(e,'work',location)}>
          <Select name="status" label="Status servis" value={ticket.status} choices={statuses.map(s=>[s,s])}/>
          <Input name="cost" label="Biaya akhir (Rp)" type="number" value={ticket.cost}/>
          <Input name="warranty" label="Garansi (hari)" type="number" value={ticket.warranty}/>
          <label className="wide">Hasil pemeriksaan dan tindakan<textarea name="action_taken" defaultValue={ticket.action_taken} maxLength={500}/></label>
          <button disabled={busy}>Simpan pengerjaan</button>
        </form></section>}
        {active&&[['deposit',ticket.intake],['settlement',ticket.pickup]].filter(([cmd,b])=>can('cashier',b)&&(cmd==='deposit'||ticket.cost!==null)).map(([cmd,b])=>
          <section className="panel" key={cmd}><h2>{eventNames[cmd]} · {name(b)}</h2><form className="row" onSubmit={e=>command(e,cmd,b)}>
            <Input name="amount" label="Nominal (Rp)" type="number" required/>
            <Select name="method" label="Metode" choices={['Tunai','QRIS','Transfer','Kartu'].map(m=>[m,m])}/><button disabled={busy}>Catat pembayaran</button>
          </form></section>)}
        {active&&ticket.status==='Siap diambil'&&can('cashier',ticket.pickup)&&<section className="panel"><h2>Penyerahan barang</h2>
          <form className="row" onSubmit={e=>command(e,'pickup',ticket.pickup)}>
            <Input name="handed_by" label="Nama penyerah" required/><Input name="picked_by" label="Nama pengambil" required/><button disabled={busy}>Serahkan barang</button></form>
        </section>}
        <section className="panel"><h2>Riwayat tiket</h2><ul>{events.map(e=><li key={e.id}>{when(e.at)} · {name(e.branch)} · {eventNames[e.event]} {e.detail&&'· '+name(e.detail)} {e.amount&&'· '+money(e.amount)}</li>)}</ul></section>
      </article>}
    </main>
    {print&&<PrintSheet {...print} pickupName={name(print.ticket.pickup)}/>}
  </>;
}
function PrintSheet({kind,ticket:t,branch,staff,customer,pickupName}){
  const receipt=kind==='receipt';
  const booking=[['Perangkat',t.device],['Nomor seri',t.serial],['Kelengkapan',t.accessories],['Keluhan',t.complaint]];
  const data=receipt?[...booking,['Estimasi biaya',money(t.estimate)],['DP diterima',money(t.deposit)]]:
    [...booking,['Tindakan',t.action_taken],['Total servis',money(t.cost)],['Uang muka',money(t.deposit)],
     ['Pembayaran setelah DP',money(t.settlement)],['Metode pembayaran terakhir',t.method],['Sisa pembayaran','Rp0 · LUNAS'],['Garansi',t.warranty?t.warranty+' hari sejak barang diambil':'Tidak ada']];
  return <div className="print-sheet">
    <div className="print-head"><div><strong>MAKASSAR COMPUTINDO</strong><p>Cabang {branch?.name}<br/>{branch?.address}<br/>{branch?.phone}</p></div>
      <div><h1>{receipt?'Tanda Terima Servis':'Nota Servis'}</h1><strong>{t.number}</strong></div></div>
    <p>Pelanggan <strong>{t.customer}</strong> {t.phone&&'· '+t.phone.replace(/.(?=.{4})/g,'*')}</p>
    <p>Diterima {when(t.created_at)}{!receipt&&' · Diambil '+when(t.picked_up_at)}</p>
    <table><tbody>{data.map(([k,v])=><tr key={k}><th scope="row">{k}</th><td>{v||'—'}</td></tr>)}</tbody></table>
    <section className="print-qr">{staff&&<div><img src={staff} alt="QR petugas"/>Buka tiket petugas</div>}
      <div><img src={customer} alt="QR pelanggan"/>{receipt?'Lacak servis':'Lihat status dan garansi'}</div></section>
    {receipt&&<p>Bawa tanda terima ini saat pengambilan di Cabang {pickupName}.</p>}
    <section className="signatures"><span>{receipt?'Penerima · '+t.receiver:'Penyerah · '+t.handed_by}</span>
      <span>{receipt?'Pelanggan · '+t.customer:'Pengambil · '+t.picked_by}</span></section>
  </div>;
}
