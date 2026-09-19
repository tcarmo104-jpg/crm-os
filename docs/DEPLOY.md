# Guía de despliegue (GitHub + Supabase + Vercel)

Tiempo estimado: 45–60 minutos la primera vez. Haz todo primero en **staging** (`crm-staging`).

## 1. GitHub

1. Descomprime `crm-os.zip`.
2. En tu repositorio `crm-os` (privado): **Add file → Upload files**, arrastra **todo el contenido** de la carpeta
   (incluida la carpeta oculta `.github`) y pulsa **Commit changes**.
   - Si el navegador no deja subir carpetas ocultas, instala **GitHub Desktop** y arrastra la carpeta completa.
3. Cuando el repo esté subido, en la pestaña **Actions** verás tres verificaciones ("Base de datos", "Integración" y "Aplicación").
   Deben quedar en verde.

## 2. Supabase

> **Atajo recomendado:** en un proyecto Supabase **vacío** no necesitas ejecutar las migraciones una por una: abre
> `supabase/setup-all.sql`, cópialo entero, pégalo en *SQL Editor → New query* y pulsa **Run** (va en una sola transacción).
> Debe terminar mostrando una fila con `estado = LISTO`. Las migraciones individuales (abajo) son para proyectos que ya tienen datos.

**Migraciones nuevas.** En **SQL Editor → New query** pega y ejecuta, **una por una y en este orden**
(cada una en su propia consulta; espera el «Success» antes de la siguiente):
1. `supabase/migrations/20260919000006_custom_fields.sql`
2. `supabase/migrations/20260919000007_customers_identity.sql`
3. `supabase/migrations/20260919000008_lead_ingestion_and_api_keys.sql`
4. `supabase/migrations/20260919000009_pipelines_opportunities.sql`
5. `supabase/migrations/20260919000010_tasks_activities.sql`

> **⚠ Si ya aplicaste la Fase 2 (0006–0008) en tu proyecto, aplica la 0009 cuanto antes:** corrige un fallo de autorización
> (un vendedor podía operar por RPC sobre clientes *sin propietario* si conocía su identificador). Además:
> - Crea el pipeline «Ventas» en las organizaciones que ya tengas.
> - **Reduce a «solo los suyos»** el acceso de *marketing, servicio al cliente, analista y viewer* a oportunidades y tareas
>   (para que no vean datos de clientes que no pueden ver). Si algún rol necesita ver todo, se le concede de forma explícita.

(las migraciones 0001 a 0005 ya deberían estar aplicadas; si no, ejecútalas antes, en orden).

**Autenticación** — en **Authentication**:
- **URL Configuration → Site URL:** la URL de tu app en Vercel (paso 3). Mientras no la tengas, `http://localhost:3000`.
- **URL Configuration → Redirect URLs:** agrega `https://TU-APP.vercel.app/auth/callback` y `http://localhost:3000/auth/callback`.
- **Sign In / Providers → Email:** deja activado **Confirm email**. Las invitaciones exigen un correo verificado.
- **Correo saliente:** el servicio de correo incluido en Supabase tiene un límite muy bajo de mensajes por hora
  (sirve para probar). Para uso real configura tu propio SMTP en **Authentication → SMTP Settings**
  (por ejemplo Resend, Postmark o Amazon SES).

**Claves** — en **Project Settings → API** (o *API Keys*) necesitarás:
- La **URL** del proyecto.
- La clave **anon** (o *publishable*): pública.
- La clave **service_role** (o *secret*): **secreta**. Solo va en Vercel, nunca en GitHub ni en el chat.

## 3. Vercel

1. Crea cuenta en vercel.com con tu GitHub → **Add New… → Project** → importa `crm-os`.
2. Framework: Next.js (se detecta solo). No cambies nada más.
3. **Environment Variables** (antes de pulsar Deploy):

| Nombre | Valor | Notas |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | clave anon/publishable | pública |
| `SUPABASE_SERVICE_ROLE_KEY` | clave service_role/secret | márcala **Sensitive** |
| `CRON_SECRET` | texto aleatorio de 32+ caracteres | genéralo con un gestor de contraseñas |
| `NEXT_PUBLIC_SITE_URL` | `https://TU-APP.vercel.app` | ponla tras el primer deploy y vuelve a desplegar |

4. **Deploy**. Cuando termine, copia la URL, actualiza `NEXT_PUBLIC_SITE_URL` y el *Site URL* de Supabase, y
   haz **Redeploy** (Deployments → ⋯ → Redeploy).

## 4. Prueba de punta a punta (staging)

1. Abre la app → **Crear cuenta** → confirma el correo → entras a **Crear organización**.
2. Crea la organización. Verás el tablero **Hoy** con los "Primeros pasos".
3. **Equipos** → crea uno. **Miembros** → **Invitar a alguien** (otro correo tuyo) → copia el enlace.
4. Abre el enlace en una **ventana privada** → crea cuenta con ese correo → confirma → acepta la invitación.
5. Verifica con esa segunda cuenta que solo ve lo que su rol permite (un vendedor no ve el formulario de invitar).

## 5. Procesamiento de eventos (después del primer deploy)

Los eventos (invitaciones creadas, etc.) se procesan llamando a `/api/cron/dispatch-events`.
Recomendado: **pg_cron de Supabase**, cada minuto. En **Database → Extensions** activa `pg_cron` y `pg_net`, y en el
SQL Editor ejecuta (reemplaza la URL y el secreto):

```sql
select cron.schedule(
  'dispatch-events',
  '* * * * *',
  $$ select net.http_post(
       url     := 'https://TU-APP.vercel.app/api/cron/dispatch-events',
       headers := jsonb_build_object('Authorization', 'Bearer TU_CRON_SECRET')
     ); $$
);
```

Para detenerlo: `select cron.unschedule('dispatch-events');`
Alternativa: Vercel Cron (la frecuencia mínima depende de tu plan de Vercel; verifícalo antes de usarlo).

Comprobación manual: `curl -H "Authorization: Bearer TU_CRON_SECRET" https://TU-APP.vercel.app/api/cron/dispatch-events`
debe responder `{"ok":true,...}`; sin el secreto responde 401.

## 6. Desarrollo local (opcional)

```bash
npm install
cp .env.example .env.local     # completa los valores
npm run dev                    # http://localhost:3000
npm run typecheck && npm test  # verificaciones
npm run test:db                # requiere PostgreSQL local
```

## 7. Problemas frecuentes

| Síntoma | Causa probable | Solución |
|---|---|---|
| "Faltan NEXT_PUBLIC_SUPABASE_URL…" | Variables sin configurar en Vercel | Agrégalas y haz Redeploy |
| Al confirmar el correo vuelve a "El enlace no es válido" | Redirect URL sin registrar | Revisa el paso 2 (Redirect URLs) |
| No llega el correo de confirmación | Límite del correo incluido en Supabase | Configura SMTP propio |
| Al aceptar invitación: "otro correo" | Sesión con un correo distinto al invitado | Cierra sesión y entra con el correo invitado |
| Al aceptar: "Verifica tu correo" | La cuenta nueva no confirmó el email | Abre el correo de confirmación |
| Error de permisos al crear organización | Falta aplicar alguna migración | Aplica 0001 → 0010 en orden |

## Probar la Fase 2 en tu proyecto (15 minutos)

Las pruebas automáticas cubren la base de datos y la API contra PostgREST, pero **nunca se han ejecutado contra tu proyecto
Supabase real**. Antes de confiar en la Fase 2, recorre esto y avísame de cualquier cosa rara:

1. **Clientes:** en *Clientes → Nuevo cliente* crea a «Carlos Rodríguez» con un teléfono. Vuelve a crearlo con el mismo teléfono:
   debe llevarte a su ficha, no crear otro.
2. **Vendedor no ve lo ajeno:** invita a un segundo usuario como *Sales agent*, entra con él y comprueba que no ve a Carlos.
   Intenta crear el mismo teléfono: debe decir que ya está registrado y **no** revelar de quién es. Como admin, en
   *Duplicados* debe aparecer la alerta.
3. **Importar CSV:** en *Leads → Importar CSV* sube un archivo de 5–10 filas (con una fila sin teléfono ni correo a propósito).
   Debe importar las buenas y listar la mala con su número de fila.
4. **API:** en *Integraciones* crea una llave y ejecuta el ejemplo `curl` que aparece (desde tu computador). Debe responder
   201; repetirlo con el mismo `external_id` debe responder 200 y no duplicar el lead.
5. **Campos personalizados:** crea un campo (p. ej. «Nivel», lista) y comprueba que aparece en la ficha del cliente.
6. Revisa en Vercel → *Logs* que no haya errores 500 durante estos pasos.

## Probar la Fase 3 en tu proyecto (15 minutos)

1. **Pipeline:** en *Configuración → Pipelines* debe existir «Ventas» con 6 etapas. Cambia el nombre de una etapa y su probabilidad.
2. **Oportunidad:** desde la ficha de un cliente, *Nueva oportunidad* con monto «1.500.000». Debe aparecer en la primera columna de
   *Oportunidades*. Muévela a «Propuesta» con *Mover*.
3. **Perder y reabrir:** intenta moverla a «Perdida» **sin motivo** (debe pedirlo). Con motivo, se cierra. Entra con un vendedor:
   no debe poder reabrirla; con un manager, sí.
4. **Historial:** abre la oportunidad → *Historial de etapas*: cada movimiento con quién, cuándo y por qué.
5. **Lead → oportunidad:** en *Leads*, pulsa *Convertir* en un lead. Debe llevarte a la nueva oportunidad y el lead queda «Convertido».
   Descarta otro lead: debe exigir motivo.
6. **Tareas:** crea una tarea con fecha de hoy a una hora que ya pasó (debe aparecer como *Vencida*) y otra para mañana. Complétala
   con un resultado. Comprueba que la hora mostrada coincide con la de tu zona horaria.
7. **Visibilidad:** con un vendedor comprueba que solo ve **sus** oportunidades y tareas, y con un *viewer* que no ve ninguna.
8. **Reasignar:** como manager reasigna un cliente a otro vendedor: sus oportunidades abiertas y tareas pendientes deben pasar con él.

