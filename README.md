# Pixel Village (Offline Strategy Builder)

Pixel Village is a single-player, browser-based strategy game inspired by lane/arena progression games, but built around offline progression and level-style advancement instead of online PvP.

## Project Structure

- `index.html` — UI shell and game HUD layout
- `style.css` — game styling and responsive HUD/sidebar layout
- `game.js` — full game logic, simulation, rendering hooks, and systems

## Run Locally

You can run it with any local static server.

Example:

```bash
python3 -m http.server 8000
```

Then open:

- `http://localhost:8000/index.html`

## Notes

- Saves are stored in browser local storage.
- This project is currently set up for offline single-player gameplay.
- Character-specific units/levels can be added as the next step.
