# 🃏 UNO Online

UNO multijugador online (2 jugadores) con Node.js + Express + Socket.io.

## Correr localmente

```bash
npm install
npm start
```

Abre `http://localhost:3000` en dos pestañas.

## Deploy (Render)

1. Sube a GitHub
2. Render → New → Web Service → conecta el repo
3. Build: `npm install` · Start: `npm start`
4. **Region: Frankfurt (EU)** recomendado para jugadores en Europa 🌍
5. En Settings, cambia la región si ya creaste el servicio en otro lado

## Cómo se juega

- Crea una sala y comparte el código de 4 letras
- El segundo jugador entra y la partida arranca sola
- Toca una carta brillante para jugarla, o toca el mazo para robar
- Si robas, tu turno sigue hasta que juegues una carta jugable
- Con 2 jugadores: ⊘ skip, ⇄ reverse, +2 y +4 hacen que repitas turno
- Botón rojo **¡UNO!** cuando te quede una carta
- Chat integrado abajo

## Reglas simplificadas

- No hay acumulación de +4/+2 (una sola carta de castigo por turno)
- Si el mazo se acaba, se rebaraja el descarte
