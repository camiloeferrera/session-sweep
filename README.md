# session-sweep

Plugin de [Claude Code](https://code.claude.com) para listar y borrar las sesiones guardadas
escribiendo `:sessions` en el chat. Responde al instante desde un hook: el mensaje no llega a
Claude, no gasta tokens y no queda en la conversación.

```
> :sessions
● Operation stopped by hook: Sesiones de Claude Code: 5 · 377 KB   (● actual  ▶ abierta)

   1  ~/code/api          hace 5 min     2 KB  ● "arregla el login…"
   2  ~/code/app          hace 1 d     1.1 MB    "optimiza las imágenes…"
   3  ~                   hace 13 d      5 KB    (vacía)

  Borrar:  :sessions delete <números>  (ej: 2 · 3 4 · 1-5)  ·  delete empty  ·  delete +30d
```

## Comandos

| Comando | Qué hace |
|---|---|
| `:sessions [texto]` | Lista las sesiones; con texto, filtra por proyecto o primer mensaje |
| `:sessions delete 2` · `3 4` · `1-5` | Prepara el borrado de esos números de la última lista |
| `:sessions delete empty` | … de las sesiones sin mensajes |
| `:sessions delete +30d` | … de las que no se usan hace más de 30 días |
| `:sessions confirm` | Confirma el borrado (vale por 5 minutos) |
| `:sessions help` | Ayuda |

- Lo borrado va a la papelera del sistema (`gio trash`); sin `gio`, a `~/.claude/.trash/`.
- De cada sesión se borra la transcripción, sus subagentes, `file-history`, `session-env`,
  `tasks`, `todos` y `debug`. La memoria del proyecto no se toca.
- La sesión actual (`●`) y las abiertas en otra terminal (`▶`) nunca se borran.
- Solo sesiones de la terminal: las del app de escritorio de Claude no aparecen ni se borran.

## Instalación

Dentro de Claude Code:

```
/plugin marketplace add camiloeferrera/session-sweep
/plugin install session-sweep@session-sweep
```

O sin plugin, clonando el repo y agregando el hook a `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node /ruta/a/session-sweep/scripts/sessions.mjs", "timeout": 10 }] }
    ]
  }
}
```

Requiere Node 18+.

## Notas

Claude Code antepone `Operation stopped by hook:` a la respuesta; es la marca que pone a todo
lo que responde un hook y no se puede quitar.

## Licencia

MIT
