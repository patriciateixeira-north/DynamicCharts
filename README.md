# Dynamic Charts

Plugin de Figma de North para crear gráficos editables a partir de datos: escribes los valores, eliges un tipo y el gráfico aparece en el lienzo como capas nativas (vectores, rectángulos y texto), no como una imagen. Funciona en **Figma Design, FigJam, Figma Slides y Figma Buzz**.

## Uso

El plugin ya está publicado para la organización de North:

1. En cualquier archivo, abre **Plugins** y busca **Dynamic Charts**.
2. Elige un tipo de gráfico, un aspecto (claro, oscuro o color propio) y rellena los datos.
3. Pulsa **Create chart**.

**Dónde aparece el gráfico:** si tienes un frame o una slide seleccionada, el gráfico se crea dentro, centrado. En Slides se usa la slide que tengas abierta. Si no hay nada seleccionado, se coloca en el centro de la vista.

**Editar un gráfico:** selecciónalo en el lienzo. Sus datos se cargan en el panel; cámbialos y pulsa **Update chart**. El gráfico nuevo sustituye al anterior en la misma posición y capa. Si cambias el ancho del gráfico a mano, ese ancho se conserva al actualizar.

> **Fuentes:** por defecto los gráficos usan **Noe Display** y **Moderat**. Si no las tienes disponibles en Figma, el plugin muestra un aviso y no crea nada. Puedes elegir otras fuentes desde el menú 🎨 *Aesthetic*.

## Tipos de gráfico

| Tipo | Para qué | Datos por fila | Negativos |
|---|---|---|---|
| Vertical | Barras verticales | Etiqueta + valor | Sí |
| Horizontal | Barras horizontales | Etiqueta + valor | Sí |
| Line | Una o varias líneas (cada fila es una línea) | Nombre + valores por punto | Sí |
| Grouped | Barras agrupadas o apiladas (*overlapped*) | Etiqueta + valor por serie | Sí |
| Radar | Comparar dimensiones | Etiqueta + valor | No |
| Pie / Donut | Reparto de un total | Etiqueta + valor | No |
| Progress | Actual vs. anterior, con % de cambio | Etiqueta + actual + anterior… | No |
| Funnel | Embudo con tasa de conversión | Etapa + valor | No |
| Budget | Presupuesto con total e IVA (21 %) opcional | Concepto + importe | Sí (descuentos) |
| Table | Tabla de texto libre | Una celda por columna | — |
| KPI | Cifras destacadas | Valor + etiqueta + descripción | — |
| Timeline | Fases y tareas por fechas | Fase/tarea + inicio + fin | — |
| Index | Índice de la presentación (puede leerse solo de las slides) | Título + página | — |
| Network | Un nodo central y satélites | Etiqueta + valor (la primera fila es el centro) | No |
| Petals | Rosa polar: el radio indica el valor | Etiqueta + valor | No |
| Tree | Elementos agrupados por categoría | Elemento + categoría | — |

Los tipos que no admiten negativos los ignoran y muestran un aviso con cuántos se han descartado.

## Cómo escribir los números

Los números se pueden escribir como en España o como en inglés:

| Escribes | Se lee como |
|---|---|
| `12,5` | 12,5 |
| `1.250` | 1250 |
| `1.250,75` | 1250,75 |
| `1,250.75` | 1250,75 |
| `-3,2` | −3,2 |
| `20%` · `1.200 €` | 20 · 1200 |

- La coma sola siempre es decimal.
- Un punto seguido de exactamente tres cifras es separador de miles (`1.500` = 1500). En cualquier otro caso es decimal (`1.5` = 1,5).

En los gráficos, los números se muestran con coma decimal y sufijos K/M (`1,2K`, `3,6M`).

**Import JSON:** puedes pegar los datos en JSON con el botón *Import JSON*; el panel muestra un ejemplo del formato para cada tipo.

## Desarrollo

Requisitos: Node 18+ y la app de escritorio de Figma.

```bash
git clone https://github.com/patriciateixeira-north/DynamicCharts.git
cd DynamicCharts
npm install
npm run build      # genera code.js a partir de code.ts
```

`code.js` no está en el repositorio: hay que compilar antes de importar el plugin. Mientras desarrollas, `npm run watch` recompila automáticamente.

Para probarlo en Figma: **Plugins → Development → Import plugin from manifest…** y selecciona `manifest.json`.

### Estructura

- `code.ts`: lógica del plugin, que dibuja los gráficos con la API de Figma. Cada tipo tiene su función `draw…Chart`, registrada en `CHART_DRAWERS`.
- `ui.html`: el panel (HTML, CSS y JS en un solo archivo).
- `manifest.json`: configuración del plugin. No tiene acceso a red.

Los datos viajan de `ui.html` a `code.ts` como texto: una fila por línea y celdas separadas por tabulador (`etiqueta\tvalor1\tvalor2`). Cada gráfico guarda sus parámetros en su *plugin data*, y así se puede volver a editar. Los gráficos creados con versiones anteriores, que usaban el formato `etiqueta: valor, …`, se siguen leyendo.

Antes de abrir un PR:

```bash
npm run build && npm run lint
```

### Publicar una nueva versión

1. Haz merge a `main`.
2. Ejecuta `npm install && npm run build` en una copia limpia de `main`.
3. En la app de escritorio de Figma: **Plugins → Manage plugins**, abre Dynamic Charts y elige **Publish new version**, con una nota que resuma los cambios.

## Contribuir

Es una herramienta viva: úsala en tus presentaciones y cuéntanos qué falla o qué formatos echas en falta. Para proponer cambios, crea una rama, ábrela como Pull Request explicando qué cambia y la revisamos antes de publicar.
