const express = require("express");
const mongoose = require('mongoose'); 
const rateLimit = require("express-rate-limit");
const {currentTime, getCurrentTime} = require('./utility_tools/datetime')
const axios = require('axios');  // Importamos axios
require("dotenv").config();
console.log(process.env.MONGO_URI);
const { connectDB } = require('./db');
const { Thread } = require('./db');  
const { client, addThread, checkRunStatus, processToolCalls } = require('./coreFunctions');
const { load_tools_from_directory } = require('./tools'); // Importar cliente y funciones
const app = express();
app.use(express.json());

connectDB();
const VALID_TOKEN = process.env.VALID_TOKEN;

// Middleware para verificar la autenticación del token
const verifyHeaders = (req, res, next) => {
    const authHeader = req.headers['authorization'];

    if (!authHeader) {
        return res.status(400).json({ error: "Falta el encabezado Authorization" });
    }

    const token = authHeader.split(" ")[1];

    if (token !== VALID_TOKEN) {
        return res.status(403).json({ error: "Acceso prohibido: token no válido" });
    }

    next();
};

// Limitar a 100 mensajes por día
const chatLimiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000,  // 24 horas
    max: 100,  // Limitar a 100 mensajes por día
    message: "Has alcanzado el límite de 100 mensajes por día"
});



// Ruta para iniciar una nueva conversación
app.get('/start', async (req, res) => {
    const platform = req.query.platform || 'Not Specified';
    const username = req.query.username || 'Not Specified';
 
    try {
        console.log(`Iniciando nueva conversación desde la plataforma: ${platform} para el usuario: ${username}`);

        // Verificar si ya existe un thread para el usuario en la base de datos
        const existingThread = await Thread.findOne({ username, platform });

        if (existingThread) {
            console.log(`Usando hilo existente con ID: ${existingThread.thread_id} para el usuario: ${username}`);
            return res.status(200).json({ thread_id: existingThread.thread_id, message: 'Usando hilo existente' });
        }
        // Crear un nuevo thread en OpenAI
        const openAIThread = await client.beta.threads.create();
        if (!openAIThread || !openAIThread.id) {
            throw new Error("No se pudo obtener el 'thread_id' de OpenAI.");
        }        

        const timeResponse = await getCurrentTime();

        if (timeResponse.error) {
            throw new Error(timeResponse.error);
        }
        const currentTime = timeResponse.message.split('es: ')[1]; // Extraemos la hora del mensaje
        // Crear un nuevo thread en la base de datos con el thread_id proporcionado por OpenAI
        const newThread = new Thread({
            thread_id: openAIThread.id,  // Usar el thread_id de OpenAI
            platform: platform,
            username: username,
            timestamp: new Date(currentTime),
            status: 'Arrived'
        });

        // Guardar el nuevo thread en la base de datos
        await newThread.save();  // Asegúrate de que esté usando `.save()` para guardar en la base de datos
        console.log(`Nuevo hilo creado con ID: ${newThread.thread_id}`);

        res.status(200).json({ thread_id: newThread.thread_id, message: 'Hilo creado con éxito' });
    } catch (error) {
        console.error('Error al crear o recuperar el hilo:', error);
        res.status(500).json({ error: 'Error al crear o recuperar el hilo' });
    }
});


app.post('/chat', chatLimiter, verifyHeaders, async (req, res) => {
    const { thread_id, message } = req.body;

    if (!thread_id) {
        console.error("Error: Faltante thread_id");
        return res.status(400).json({ error: "Faltante thread_id" });
    }

    try {
        console.log(`Received message: ${message} for thread ID: ${thread_id}`);

        const messageResponse = await client.beta.threads.messages.create(thread_id, {
            role: "user",
            content: message
        });

        if (!messageResponse || !messageResponse.id) {
            throw new Error("No se pudo obtener la respuesta del mensaje correctamente.");
        }

        console.log(`Message sent successfully, response ID: ${messageResponse.id}`);

        const run = await client.beta.threads.runs.create(thread_id, {
            assistant_id: process.env.ASSISTANT_ID
        });

        if (!run || !run.id) {
            throw new Error("No se pudo obtener el run_id de la respuesta de OpenAI.");
        }

        const runId = run.id;
        console.log(`Run created with ID: ${runId}`);

        return res.status(200).json({ run_id: runId });

    } catch (error) {
        console.error('Error en /chat:', error.response ? error.response.data : error.message);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.post('/check', verifyHeaders, async (req, res) => {
    const { thread_id, run_id } = req.body;

    if (!thread_id || !run_id) {
        console.error("Error: Faltante thread_id o run_id");
        return res.status(400).json({ error: "Faltante thread_id o run_id" });
    }

    try {
        const tool_data= {
            function_map: {
                conversation_summary_request: (args) => {
                    // Implementa la lógica de la función aquí
                    return { summary: "This is a placeholder summary." };
                }
                // Otras funciones que podrían ser necesarias
            }
        };
        const result = await processToolCalls(client, thread_id, run_id, tool_data);
        return res.status(200).json(result);
    } catch (error) {
        console.error('Error al verificar el estado del run:', error.message);
        return res.status(500).json({ error: 'Error al verificar el estado de la ejecución' });
    }
});


const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Servidor corriendo en el puerto ${port}`));
