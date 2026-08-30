# VANDAL — Lista maestra (TODO lo hablado)

Estado al 2026-08-18. ✅ hecho · 🔄 en curso · 🐞 bug abierto · 📋 pendiente

## ✅ HECHO / LIVE en :4504
- Muro de grafiti cooperativo (WS binario autoritativo, bots, cliente canvas)
- Fondo de pared real (foto: 5 fotos + pegar URL + subir)
- Pared **FRONTAL** y proporcional (saqué la escena 3D falsa que la torcía)
- **UNDO** arreglado (redibujo por región, 480ms→~44ms, sin tildar)
- **Colores de spray REALES** + rack de latas (Montana/Molotow/Ironlak, cero violeta)
- **Movimiento HUMANO** (WindMouse + Steering-Law/2-3/Fitts + interpolador de cursor que reemplazó el EMA que lo aplastaba + ancho de trazo variable) — codex: FIXED
- **Cambio de lata con tiempo real** (alcanzar→agitar→prueba→pintar) + **personalidad por bot** + **dobles pasadas**
- Bots pintan grafiti **por capas** (wildstyle, 3D, contorno recut, brillos, drips, personajes, pruebas de spray)
- **Render sprayado** (rellenos con grano/borde suave/overspray — no "impresora 3D")
- **Street View / GPS** (geolocalización → pintar sobre foto real del lugar) — FUNCIONA (key activada + proxy live)
- Librería de contenido `content.js` (67 frases, 59 fútbol, 38 ultras, 110 writer-words, 51 subjects, esquemas por tier, 29 imgs reales)
- Taxonomía de **22 estilos** (`graffiti-styles.md`) + set de referencia + `human-motion-data.md`
- Fix **freeze del marcador** + cap de puntos a perfect-freehand + **`no-cache`** (para que siempre veas lo último)

## 🔄 EN CURSO (agentes/workflows)
- **Piezas complejas** → `bots.js` (agente): mutación de esqueleto STEP 0, letras entrelazadas, flechas, barras, force-field, 3D — preservando el movimiento
- **Corpus geolocalizado por país** → `content-geo.js` (workflow): crews, slogans en idioma local, fútbol/ultras (incl. Argentina), `countryAt(lat,lng)`, `expand()` → cientos de miles

## 🐞 BUGS ABIERTOS
- **Toolbar todavía tiene cuadrado / recta / círculo** → reemplazar por herramientas de grafiti REALES (todas freehand), sin primitivas geométricas
- Otras tools se tildaban en preview (buff/roller/stencil) → protegido con cap de puntos; **verificar**
- **"La pared no se expande"** (zoom/ampliar/paneo) → investigar y arreglar
- Íconos de tools que se leen como geométricos

## 📋 PENDIENTE (pedido, no empezado)
- **La herramienta SOLO afecta la zona donde está el jugador** (radio de pintura alrededor de tu posición)
- **Street View 360** (varios `heading` → panear alrededor)
- **Fútbol argentino + más estilos** (parte del corpus geo)
- Reproducir un grafiti **desde una imagen** (cliente Python: OpenCV / Paint-Transformer / PyPainterly)

## 🔒 REGLAS PERMANENTES
- CERO violeta/púrpura/magenta/índigo
- No inventar arte feo (assets reales / vector limpio)
- **No cambiar el protocolo binario** (ports Go/Python/Rust/Node dependen byte a byte)
- Paleta cálida pastel
- Opinión externa (codex) + verificación con capturas; el **movimiento** se verifica EN VIDEO
