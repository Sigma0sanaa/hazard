"""Blind stratified sample for the accuracy check of the coal map: 40 mapped coal, 25 random other, 15 dark other pixels
in the central 14 km. Writes shuffled 10 m image chips (labels hidden) for visual interpretation; labels go to accuracy_labels.csv."""
import sys, json, numpy as np
sys.argv=['x', sys.argv[1] if len(sys.argv)>1 else 'out', 'results']
sys.path.insert(0, '.')
import analyze as A
from PIL import Image, ImageDraw, ImageFont
G=A.G; R=A.R
s2=A.indices(A.load_refl('' + A.IN + '/s2_2024.npz'))
coal=(s2['BCI']>=0.8)&(s2['NDWI']<=-0.05)
z=np.load('' + A.IN + '/s2_rgb10_core_2024.npz'); rgb=z['data'].astype(float); rgb[rgb==-32768]=np.nan; rgb/=10000
cx0,cy0=float(z['x0']),float(z['y0'])
# core window on the 30 m grid (keep 300 m from the core edge)
inside=(A.XX>cx0+300)&(A.XX<cx0+14000-300)&(A.YY<cy0-300)&(A.YY>cy0-14000+300)&np.isfinite(s2['VIS'])
rng=np.random.default_rng(7)
def pick(mask,n):
    idx=np.flatnonzero(mask); return rng.choice(idx,n,replace=False)
c=pick(inside&coal,40); nr=pick(inside&~coal,25); nd=pick(inside&~coal&(s2['VIS']<0.10),15)
pts=[(int(i),'coal') for i in c]+[(int(i),'non') for i in nr]+[(int(i),'non_dark') for i in nd]
order=rng.permutation(len(pts))
recs=[]
font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',16)
tiles=[]
for k,o in enumerate(order):
    i,st=pts[o]; r_,c_=divmod(i,A.N)
    x,y=A.XC[c_],A.YC[r_]
    col=int((x-cx0)//10); row=int((cy0-y)//10)
    sub=rgb[:,row-10:row+11,col-10:col+11]
    im=np.clip((np.transpose(sub,(1,2,0))-0.02)/(0.40-0.02),0,1)**(1/1.3)
    im=(np.nan_to_num(im)*255).astype(np.uint8)
    t=Image.fromarray(im).resize((168,168),Image.NEAREST)
    d=ImageDraw.Draw(t); d.rectangle([9*8,9*8,12*8-1,12*8-1],outline=(255,0,0),width=2)
    d.rectangle([0,0,34,20],fill=(255,255,255)); d.text((2,1),f"{k+1}",fill=(0,0,0),font=font)
    tiles.append(t)
    recs.append(dict(id=k+1,stratum=st,predicted=int(coal.flat[i]),x=float(x),y=float(y),BCI=float(s2['BCI'].flat[i]),VIS=float(s2['VIS'].flat[i])))
for s in range(0,80,40):
    sheet=Image.new('RGB',(8*172,5*172),'white')
    for j,t in enumerate(tiles[s:s+40]): sheet.paste(t,((j%8)*172,(j//8)*172))
    sheet.save(f'results/accuracy/chips_{s//40+1}.png')
json.dump(recs,open('results/accuracy/points_hidden.json','w'))
print('coal px in core', int((inside&coal).sum()), 'dark non-coal', int((inside&~coal&(s2['VIS']<0.10)).sum()))
