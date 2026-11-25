/* Fortune's Gambit: THE RULES, in one file.
 *
 * Everything that decides what is legal and how battles turn out lives here:
 * chess moves, piece stats and abilities, relics, battle odds, dice rolls, and
 * applying a battle's result to the board.
 *
 * There is NO three.js, no drawing, no sound and no page code in this file, so the
 * exact same file can run in the browser (single player) and on the Node.js duel
 * server (the referee). If you change a rule, change it here and both stay in step.
 *
 * Sections:
 *   1. Chess engine (moves, check, castling, en passant, failed attacks)
 *   2. Battle maths (odds curve, seeded dice, the roll itself)
 *   3. Board helpers (who has won, new-board reset, Bishop's Blessing targets)
 *   4. Pieces and relics (stats, abilities, relic list)
 *   5. Battle odds for a real board position
 *   6. Applying moves and battle results to the board
 */

/* ===== 1. Chess engine ===== */
export const FILES = 'abcdefgh';
const back = 'rnbqkbnr';
const rank = sq => Number(sq?.[1])-1;
const file = sq => FILES.indexOf(sq?.[0]);
const sq = (x,y) => x>=0&&x<8&&y>=0&&y<8 ? FILES[x]+(y+1) : null;
const opponent = c => c==='w'?'b':'w';
const copyPiece = p => p ? {...p} : null;

export class BattleChess {
  constructor(empty=false){
    this.board = new Map(); this.side='w'; this.ep=null; this.halfmove=0;this.fullmove=1;
    this.positions=new Map();
    if(!empty){for(let f=0;f<8;f++){
      this.board.set(sq(f,0),{type:back[f],color:'w',moved:false});
      this.board.set(sq(f,1),{type:'p',color:'w',moved:false});
      this.board.set(sq(f,6),{type:'p',color:'b',moved:false});
      this.board.set(sq(f,7),{type:back[f],color:'b',moved:false});
    }}
    this.track();
  }
  clone(){const c=new BattleChess(true);c.board=new Map([...this.board].map(([s,p])=>[s,{...p}])); c.side=this.side;
    c.ep=this.ep;c.halfmove=this.halfmove;c.fullmove=this.fullmove;c.positions=new Map(this.positions);return c}
  turn(){return this.side}
  get(square){return copyPiece(this.board.get(square))}
  remove(square){const p=this.get(square);this.board.delete(square);return p}
  put(piece,square){if(!sq(file(square),rank(square)))return false;
    this.board.set(square,{type:piece.type,color:piece.color,moved:piece.moved??true});return true}
  clear(){this.board.clear();this.ep=null;this.side='w';this.halfmove=0;this.fullmove=1;this.positions.clear();this.track()}
  key(){let s='';for(let y=0;y<8;y++)for(let x=0;x<8;x++){const p=this.board.get(sq(x,y));s+=p?`${p.color}${p.type}${p.moved?'1':'0'}`:'..';}return s+this.side+(this.ep||'-')}
  track(){const k=this.key();this.positions.set(k,(this.positions.get(k)||0)+1)}
  kingSquare(color){for(const [square,p] of this.board)if(p.color===color&&p.type==='k')return square;return null}
  attacked(target,by){
    if(!target)return false;
    const tx=file(target),ty=rank(target);
    for(const [from,p] of this.board){if(p.color!==by)continue;
      const dx=tx-file(from),dy=ty-rank(from),ax=Math.abs(dx),ay=Math.abs(dy);
      if(p.type==='p'){if(ay===1&&ax===1&&dy===(by==='w'?1:-1))return true;continue}
      if(p.type==='n'){if(ax*ay===2&&(ax===1||ay===1))return true;continue}
      if(p.type==='k'){if(Math.max(ax,ay)===1)return true;continue}
      if(p.type==='r'&&dx!==0&&dy!==0)continue;
      if(p.type==='b'&&ax!==ay)continue;
      if(p.type==='q'&&!(dx===0||dy===0||ax===ay))continue;
      if(!['r','b','q'].includes(p.type)||(!dx&&!dy))continue;
      const stepX=Math.sign(dx),stepY=Math.sign(dy);let x=file(from)+stepX,y=rank(from)+stepY,blocked=false;
      while(x!==tx||y!==ty){if(this.board.has(sq(x,y))){blocked=true;break}x+=stepX;y+=stepY}
      if(!blocked)return true;
    }
    return false;
  }
  isCheck(color=this.side){const king=this.kingSquare(color);return !!king&&this.attacked(king,opponent(color))}
  pseudo(from){
    const p=this.board.get(from);if(!p||p.color!==this.side)return [];
    const moves=[],x=file(from),y=rank(from),c=p.color;
    const push=(to,flags='',promotion)=>{
      if(!to)return false;const victim=this.board.get(to);
      if(victim?.color===c)return false;
      const m={from,to,piece:p.type,color:c,flags,captured:victim?.type,promotion};
      moves.push(m);return !victim;
    };
    const pawnPush=(dest,flags='',captured)=>{
      const last=rank(dest)===(c==='w'?7:0);
      for(const promote of (last?['q','r','b','n']:[undefined])){
        const m={from,to:dest,piece:'p',color:c,flags:flags+(last?'p':''),captured,promotion:promote};moves.push(m)
      }
    };
    if(p.type==='p'){
      const dir=c==='w'?1:-1,first=c==='w'?1:6;
      const one=sq(x,y+dir);
      if(one&&!this.board.has(one)){
        pawnPush(one);
        const two=sq(x,y+2*dir);
        // v2.7: based on the pawn's row only. A pawn that attacked and failed from its
        // start square, or a survivor placed back on it for a new board, keeps this move.
        if(y===first&&two&&!this.board.has(two))pawnPush(two,'b');
      }
      for(const dx of [-1,1]){
        const to=sq(x+dx,y+dir);if(!to)continue;
        const victim=this.board.get(to);
        if(victim&&victim.color!==c)pawnPush(to,'c',victim.type);
        else if(to===this.ep){const capturedSquare=sq(x+dx,y),capturedPawn=this.board.get(capturedSquare);
          if(capturedPawn?.type==='p'&&capturedPawn.color!==c){
            pawnPush(to,'e','p');for(const m of moves.filter(m=>m.to===to))m.capturedSquare=capturedSquare;
          }
        }
      }
    }else if(p.type==='n'){
      for(const [dx,dy] of [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]])push(sq(x+dx,y+dy));
    }else if(p.type==='k'){
      for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)if(dx||dy)push(sq(x+dx,y+dy));
      if(!p.moved&&!this.isCheck(c))for(const [dir,rookF,between] of [[1,7,[5,6]],[-1,0,[1,2,3]]]){
        const rook=this.board.get(sq(rookF,y));
        if(!rook||rook.type!=='r'||rook.color!==c||rook.moved)continue;
        if(between.some(f=>this.board.has(sq(f,y))))continue;
        if(this.attacked(sq(x+dir,y),opponent(c))||this.attacked(sq(x+2*dir,y),opponent(c)))continue;
        moves.push({from,to:sq(x+dir*2,y),piece:'k',color:c,flags:dir===1?'k':'q'});
      }
    }else{
      const dirs=[];
      if(p.type==='r'||p.type==='q')dirs.push([1,0],[-1,0],[0,1],[0,-1]);
      if(p.type==='b'||p.type==='q')dirs.push([1,1],[1,-1],[-1,1],[-1,-1]);
      for(const [dx,dy] of dirs){let nx=x+dx,ny=y+dy;while(sq(nx,ny)){
        if(!push(sq(nx,ny)))break;nx+=dx;ny+=dy;
      }}
    }
    return moves;
  }
  moves({square,verbose=true}={}){
    const result=[];
    for(const from of (square?[square]:[...this.board.keys()])){
      const p=this.board.get(from);if(!p||p.color!==this.side)continue;
      for(const m of this.pseudo(from)){
        const next=this.clone();next.commit(m,false);
        const king=next.kingSquare(p.color);
        // Only legal movement destinations; a failed attempt is a separate turn action.
        if(king&&!next.attacked(king,opponent(p.color)))result.push(m);
      }
    }
    return verbose?result:result.map(m=>m.from+m.to+(m.promotion||''));
  }
  commit(move,track=true){
    const p=this.board.get(move.from);if(!p)return false;
    this.board.delete(move.from);this.board.delete(move.to);
    if(move.flags.includes('e'))this.board.delete(move.capturedSquare||sq(file(move.to),rank(move.from)));
    if(move.flags.includes('k')||move.flags.includes('q')){
      const y=rank(move.from),kingside=move.flags.includes('k');
      const rookFrom=sq(kingside?7:0,y),rookTo=sq(kingside?5:3,y);
      const rook=this.board.get(rookFrom);this.board.delete(rookFrom);
      if(rook)this.board.set(rookTo,{...rook,moved:true});
    }
    this.board.set(move.to,{...p,moved:true,type:move.promotion||p.type});
    this.ep=move.flags.includes('b')?sq(file(move.from),rank(move.from)+(p.color==='w'?1:-1)):null;
    this.halfmove=(p.type==='p'||move.captured)?0:this.halfmove+1;
    if(p.color==='b')this.fullmove++;
    this.side=opponent(this.side);
    if(track)this.track();return true;
  }
  move({from,to,promotion='q'}){
    const m=this.moves({square:from}).find(m=>m.to===to&&(!m.promotion||m.promotion===promotion));
    if(!m)return null;this.commit(m);return m;
  }
  pass({attemptFrom,slain=false}={}){
    // A failed attack consumes the turn; an attacker which survived is marked moved.
    if(attemptFrom){const p=this.board.get(attemptFrom);if(p&&!slain)p.moved=true}
    this.ep=null;this.halfmove++;
    if(this.side==='b')this.fullmove++;
    this.side=opponent(this.side);this.track();
  }
  failureExposesKing(move){
    // v2.7: would the attacker's own king be in check if this attack were repelled or
    // the attacker slain? Used only to warn the player before they commit.
    const color=this.board.get(move.from)?.color;if(!color)return false;
    const repelled=this.clone();repelled.pass({attemptFrom:move.from});
    const slain=this.clone();slain.remove(move.from);slain.pass({attemptFrom:move.from,slain:true});
    return repelled.isCheck(color)||slain.isCheck(color);
  }
  isInsufficientMaterial(){
    const rest=[...this.board].filter(([,p])=>p.type!=='k');
    if(rest.length===0)return true;
    if(rest.length===1&&['b','n'].includes(rest[0][1].type))return true;
    if(rest.every(([,p])=>p.type==='b')&&rest.length<=2){
      const colors=rest.map(([s])=>(file(s)+rank(s))%2);
      return colors.every(c=>c===colors[0]);
    }
    return false;
  }
  isCheckmate(){return this.isCheck()&&this.moves().length===0}
  isStalemate(){return !this.isCheck()&&this.moves().length===0}
  isDraw(){return this.isStalemate()||this.isInsufficientMaterial()||this.halfmove>=100||(this.positions.get(this.key())||0)>=3}
}

/* ===== 2. Battle maths ===== */
/* Predictable battle rolls; separate deterministic streams for combat and opponent. */
export const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
export const hashSeed=(value)=>{let h=2166136261;for(const c of String(value)){h=Math.imul(h^c.charCodeAt(0),16777619)}return h>>>0};
export function makeRng(seed){let s=seed>>>0;return ()=>{
  let t=(s+=0x6d2b79f5);t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);
  return ((t^(t>>>14))>>>0)/4294967296;
}}
export function rawChance(might,guard){return clamp(1/(1+Math.exp(-.6*(might-guard))),.05,.95)}
export function resolveBattle({winChance,defMight,attGuard,attNerve,attHp,rng}){
  // Fixed three combat draws, irrespective of branch; animation/AI never touch this RNG.
  const roll=rng(),counterRoll=rng(),woundRoll=rng();
  const retaliation=clamp(rawChance(defMight,attGuard)-(attNerve*.03),.05,.95);
  const kind=roll<winChance?'victory':((counterRoll<retaliation||attHp<=1)?'slain':'repelled');
  return {kind,winChance,roll,retaliation,wound:kind==='victory'&&attHp>1&&woundRoll<.23};
}
export function winWoundRate(hp){return hp>1?.23:0}
export function nextMomentumStreak(streak,winChance,result){return result==='victory'?0:(winChance>=.60?Math.min(3,streak+1):0)}

/* v2.11: the three outcomes of a battle as probabilities that add up to 1. */
export function outcomeOdds(winChance,slainOnFailure){
  const lose=1-winChance;
  return {victory:winChance,repelled:lose*(1-slainOnFailure),slain:lose*slainOnFailure};
}
/* Whole-number percentages that always total exactly 100 (largest remainder). */
export function roundPercents(values){
  const raw=values.map(v=>v*100),floors=raw.map(Math.floor);
  let left=100-floors.reduce((a,b)=>a+b,0);
  raw.map((v,i)=>[v-floors[i],i]).sort((a,b)=>b[0]-a[0]).forEach(([,i])=>{if(left>0){floors[i]++;left--}});
  return floors;
}
/* v2.11 Knight Charge: only when the knight leaps over a piece. A knight's L-move
   crosses a 2x3 block of squares; any piece on the 4 squares between start and
   landing counts. `occupied(square)` returns true when a piece stands there. */
export function knightJumpsOver(from,to,occupied){
  const f0=from.charCodeAt(0)-97,r0=+from[1]-1,f1=to.charCodeAt(0)-97,r1=+to[1]-1;
  for(let f=Math.min(f0,f1);f<=Math.max(f0,f1);f++)for(let r=Math.min(r0,r1);r<=Math.max(r0,r1);r++){
    const sq=String.fromCharCode(97+f)+(r+1);
    if(sq!==from&&sq!==to&&occupied(sq))return true;
  }
  return false;
}

/* ===== 3. Board helpers ===== */
/* Deterministic board result evaluation. Royal deaths always precede mate and draws. */
export function boardOutcome(chess,pieces){
  const survivors=[...pieces.values()];
  if(!survivors.some(p=>p.color==='w'&&p.type==='k'))return 'player-lost';
  if(!survivors.some(p=>p.color==='b'&&p.type==='k'))return 'player-won';
  if(chess.isCheckmate())return chess.turn()==='b'?'player-won':'player-lost';
  if(chess.isDraw())return 'draw';
  return 'ongoing';
}

/* v2.7: a surviving piece starts each new board as unmoved (rooks regain Fortress,
   king and rooks regain castling), but keeps its wounds and promotions. */
export function freshForNewBoard(piece){return {...piece,moves:0,blessUsed:false,blessed:false}}

/* v2.15 Bishop's Blessing: the allies a bishop can bless are the first piece it meets
   along each diagonal, if that piece is on its own side and not already blessed.
   pieceAt(square) returns {color, blessed} or null. */
export function blessTargets(from,color,pieceAt){
  const x=FILES.indexOf(from[0]),y=Number(from[1])-1,out=[];
  for(const [dx,dy] of [[1,1],[1,-1],[-1,1],[-1,-1]]){
    let nx=x+dx,ny=y+dy;
    while(nx>=0&&nx<8&&ny>=0&&ny<8){
      const sq=FILES[nx]+(ny+1),p=pieceAt(sq);
      if(p){if(p.color===color&&!p.blessed)out.push(sq);break}
      nx+=dx;ny+=dy;
    }
  }
  return out;
}

/* ===== 4. Pieces and relics ===== */
export const STATS = {p:{might:2,guard:2,hp:1,nerve:0},n:{might:4,guard:3,hp:2,nerve:1},b:{might:3,guard:3,hp:2,nerve:1},r:{might:5,guard:5,hp:3,nerve:2},q:{might:6,guard:4,hp:3,nerve:2},k:{might:3,guard:6,hp:3,nerve:3}};
export const ABILITIES = {p:'Shield Wall: +1 Guard beside an allied pawn. Spearpoint: +1 Might when attacking.',n:'Charge: +15% when it leaps over a piece to attack.',b:'Blessing: once per board, give an ally it can see along its diagonals +20% in its next battle. Free: it does not use your turn.',r:'Fortress: +2 Guard until it first moves or attacks.',q:'Command: its attacks never drop below 40%.',k:'Last Stand: anyone attacking it gets −25%.'};
export const RELICS = {
  whetstone:{icon:'sword',name:'Whetstone',desc:'Your knights get +10% when attacking'},
  bulwark:{icon:'shield',name:'Iron Bulwark',desc:'Every piece in your army gets +1 Guard'},
  mercy:{icon:'heal',name:'Field Surgeon',desc:'Heals one wound on every survivor'}
};
/* Duel boons (v2.28, draft duels only). The server deals BOON_OFFER of these to both players,
   and each picks BOON_PICKS. They work like relics: ctx.relics(color) holds the picked names. */
export const DUEL_BOONS = {
  whetstone:{name:'Whetstone',desc:'Knights get +10% when attacking.'},
  siege:{name:'Siege Oil',desc:'Rooks get +10% when attacking.'},
  pilgrim:{name:"Pilgrim's Blade",desc:'Bishops get +10% when attacking.'},
  favour:{name:"Queen's Favour",desc:'Your queen gets +10% when attacking.'},
  pikewall:{name:'Pike Wall',desc:'Pawns get +1 Guard.'},
  royalguard:{name:'Royal Guard',desc:'Your king gets +2 Guard.'},
  fervour:{name:'Battle Fervour',desc:'Momentum: if three of your attacks in a row fail when the odds were 60% or better, your next attack gets +10%.'}
};
export const BOON_OFFER=3, BOON_PICKS=2;
/* Deal `n` different boons using a seeded dice stream, so the same seed always deals the same boons. */
export function dealBoons(rng,n=BOON_OFFER){
  const pool=Object.keys(DUEL_BOONS);
  for(let i=pool.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]]}
  return pool.slice(0,n);
}
/* A valid pick: exactly BOON_PICKS different boons, all from the offer. */
export function validBoonPick(offer,picks){
  return Array.isArray(picks)&&picks.length===BOON_PICKS&&new Set(picks).size===BOON_PICKS&&picks.every(b=>offer.includes(b));
}
export function makePiece(type,color,home){return {id:`${color}-${home}`,home,color,type,hp:STATS[type].hp,maxHp:STATS[type].hp,mightBuff:0,guardBuff:0,moves:0,blessUsed:false,blessed:false}}

/* ===== 5. Battle odds for a real board position =====
 * Both take a `ctx` object that describes the board:
 *   ctx.pieceAt(square)  -> the piece on that square, or undefined
 *   ctx.relics(color)    -> a Set of relic names that side owns ('whetstone', 'bulwark')
 *   ctx.momentum(color)  -> that side's Momentum streak (3 or more gives +10%)
 * Single player gives relics and Momentum to Dawn ('w') only. A duel can give them to either side.
 */
const NO_RELICS=new Set();
const relicsOf=(ctx,color)=>ctx.relics?.(color)||NO_RELICS;
/* The square of the piece being attacked (different from `to` for en passant). */
export function defenderSquare(m){return m.flags?.includes('e')?(m.capturedSquare||m.to[0]+m.from[1]):m.to}
export function pieceStats(square,ctx){
  const p=ctx.pieceAt(square);if(!p)return {might:0,guard:0,hp:0,nerve:0};
  const base=STATS[p.type];let guard=base.guard+p.guardBuff-(p.maxHp-p.hp);
  if(relicsOf(ctx,p.color).has('bulwark'))guard+=1;
  if(p.type==='p'&&relicsOf(ctx,p.color).has('pikewall'))guard+=1;   // duel boon
  if(p.type==='k'&&relicsOf(ctx,p.color).has('royalguard'))guard+=2; // duel boon
  if(p.type==='r'&&p.moves===0)guard+=2;
  // v2.12 Shield Wall: +1 Guard if at least one allied pawn stands beside it (no longer +1 per pawn).
  if(p.type==='p'){
    const x=FILES.indexOf(square[0]),y=Number(square[1])-1;
    const beside=[-1,1].some(dx=>{if(x+dx<0||x+dx>7)return false;const n=ctx.pieceAt(FILES[x+dx]+(y+1));return n?.type==='p'&&n.color===p.color});
    if(beside)guard++;
  }
  return {might:base.might+p.mightBuff,guard:Math.max(0,guard),hp:p.hp,nerve:base.nerve};
}
export function battleForecast(m,ctx){
  const atk=ctx.pieceAt(m.from),def=ctx.pieceAt(defenderSquare(m));if(!atk||!def)return null;
  const a=pieceStats(m.from,ctx),d=pieceStats(defenderSquare(m),ctx);
  if(atk.type==='p')a.might+=1; // v2.12 Spearpoint: pawns strike harder than they defend.
  const adjustments=[],base=rawChance(a.might,d.guard);
  let chance=base;
  const add=(name,amount)=>{chance+=amount;adjustments.push({name,amount})};
  // v2.11: Charge only when the knight leaps over a piece on its way to the target.
  if(atk.type==='n'&&knightJumpsOver(m.from,m.to,s=>Boolean(ctx.pieceAt(s))))add('Knight Charge',.15);
  if(atk.type==='n'&&relicsOf(ctx,atk.color).has('whetstone'))add('Whetstone',.10);
  if(atk.type==='r'&&relicsOf(ctx,atk.color).has('siege'))add('Siege Oil',.10);
  if(atk.type==='b'&&relicsOf(ctx,atk.color).has('pilgrim'))add("Pilgrim's Blade",.10);
  if(def.type==='k')add('King Last Stand',-.25);
  if(atk.blessed)add('Blessing',.20);
  if(def.blessed)add('Defender blessed',-.20);
  if(atk.type==='q'&&chance<.40){adjustments.push({name:'Queen Command (40% floor)',amount:.40-chance});chance=.40}
  if(atk.type==='q'&&relicsOf(ctx,atk.color).has('favour'))add("Queen's Favour",.10); // after the floor, so it always helps
  if((ctx.momentum?.(atk.color)||0)>=3)add('Momentum',.10);
  chance=clamp(chance,.05,.95);
  const counter=clamp(rawChance(d.might,a.guard)-a.nerve*.03,.05,.95);
  const slainOnFailure=a.hp<=1?1:counter;
  return {chance,base,adjustments,retaliation:counter,slainOnFailure,odds:outcomeOdds(chance,slainOnFailure),winWound:winWoundRate(a.hp),attacker:atk,defender:def,attackerStats:a,defenderStats:d};
}
/* Roll a battle from its forecast. `rng` is a seeded dice stream from makeRng(). */
export function rollBattle(f,rng){
  return resolveBattle({winChance:f.chance,defMight:f.defenderStats.might,attGuard:f.attackerStats.guard,attNerve:f.attackerStats.nerve,attHp:f.attackerStats.hp,rng});
}

/* ===== 6. Applying moves and battle results to the board =====
 * `match` is {chess: a BattleChess, pieces: a Map of square -> piece}.
 * Both are changed in place, and kept in step with each other.
 */
/* A normal move, or the winning half of a battle. Returns {performed, promoted} or null if refused. */
export function applyMove(match,m){
  const {chess,pieces}=match;
  const p=pieces.get(m.from),def=pieces.get(defenderSquare(m));if(!p)return null;
  const performed=chess.move({from:m.from,to:m.to,promotion:m.promotion||'q'});
  if(!performed)return null;
  pieces.delete(m.from);
  if(def)pieces.delete(defenderSquare(m));
  if(performed.flags.includes('k')||performed.flags.includes('q')){
    const row=p.color==='w'?'1':'8';
    const fromR=performed.flags.includes('k')?'h'+row:'a'+row;
    const toR=performed.flags.includes('k')?'f'+row:'d'+row;
    const rook=pieces.get(fromR);if(rook){pieces.delete(fromR);pieces.set(toR,rook);rook.moves++}
  }
  p.moves++;
  let promoted=null;
  if(performed.flags.includes('p')){
    p.type=performed.promotion||'q';p.maxHp=Math.max(p.maxHp,STATS[p.type].hp);p.hp=Math.max(p.hp,2);promoted=p.type;
  }
  pieces.set(m.to,p);
  return {performed,promoted};
}
/* A failed attack: the attacker stays put, but the turn is used. */
export function passTurn(match,from){
  match.chess.pass({attemptFrom:from});
  const p=match.pieces.get(from);if(p)p.moves++;
}
/* A slain attacker leaves the board, and the turn is used. */
export function removeAttacker(match,from){
  if(!match.pieces.get(from))return;
  match.pieces.delete(from);match.chess.remove(from);
  match.chess.pass({attemptFrom:from,slain:true});
}
/* Apply a rolled battle. Returns {kind, promoted}. Blessings on both pieces are used up. */
export function applyBattle(match,m,result){
  const attacker=match.pieces.get(m.from),defender=match.pieces.get(defenderSquare(m));
  if(attacker)attacker.blessed=false;if(defender)defender.blessed=false; // a Blessing lasts for one battle
  let promoted=null;
  if(result.kind==='victory'){
    promoted=applyMove(match,m)?.promoted||null;
    if(result.wound){const survivor=match.pieces.get(m.to);if(survivor)survivor.hp--}
  }else if(result.kind==='repelled'){
    if(attacker)attacker.hp--;passTurn(match,m.from);
  }else removeAttacker(match,m.from);
  return {kind:result.kind,promoted};
}
