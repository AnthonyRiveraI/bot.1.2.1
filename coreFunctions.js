const express = require("express");
require("dotenv").config(); 
const OpenAI = require("openai");
const semver = require('semver');
const app = express();
app.use(express.json());
const https = require('https');
const fs = require('fs');
const path = require('path');




const OPENAI_API_KEY = process.env.OPEN_AI_KEY_ASISTANCE;
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const CUSTOM_API_KEY = process.env.CUSTOM_API_KEY; // Esta es tu clave API personalizada

// Inicialización del cliente de OpenAI
const client = new OpenAI({
    apiKey: OPENAI_API_KEY,
});

// Verificar si la clave API de OpenAI está en las variables de entorno
if (!OPENAI_API_KEY) {
    throw new Error("No se encontró la clave API de OpenAI en las variables de entorno");
}

// Middleware para verificar la clave API personalizada (CUSTOM_API_KEY)
const verifyApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    
    if (apiKey !== CUSTOM_API_KEY) {
      console.log(`Clave API inválida: ${apiKey}`);
      return res.status(401).json({ error: 'No autorizado: clave API inválida' });
    }
    
    next();
};


// Función para obtener la hora actual desde la API de World Time
const getCurrentTime = async (timezone = 'America/Lima') => {
    return new Promise((resolve, reject) => {
        const url = `https://worldtimeapi.org/api/timezone/${timezone}`;
        
        https.get(url, (res) => {
            let data = '';

            // Recibir datos por fragmentos
            res.on('data', (chunk) => {
                data += chunk;
            });

            // Una vez recibidos todos los datos
            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(data);
                    if (res.statusCode === 200) {
                        resolve(parsedData.datetime);  // Extraer la hora actual
                    } else {
                        reject(new Error(`Error en la API de World Time: ${parsedData.message}`));
                    }
                } catch (error) {
                    reject(new Error(`Error al analizar la respuesta de la API: ${error.message}`));
                }
            });
        }).on('error', (error) => {
            reject(new Error(`Error en la solicitud HTTPS: ${error.message}`));
        });
    });
};



// Función para agregar un hilo a la base de datos
async function addThread(thread_id, platform, username) {
    try {
        const currentTime = await getCurrentTime();
        const newThread = new Thread({
            thread_id,
            platform,
            username,
            timestamp: new Date(currentTime),
            status: 'Arrived'
        });
        await newThread.save();
        console.log('Hilo agregado a la base de datos con éxito.');
    } catch (error) {
        console.error('Error al agregar el hilo a la base de datos:', error);
    }
}

// Función para verificar el estado de la ejecución (run)
async function checkRunStatus(client, thread_id, run_id, tool_data) {
    try {
        if (!thread_id || !run_id) {
            console.error('Error: Faltante thread_id o run_id');
            throw new Error('Faltante thread_id o run_id');
        }

        console.log(`Verificando el estado del run con ID: ${run_id} para el hilo: ${thread_id}`);
        return { status: 'completed', run_id }; // Esto es un placeholder
    } catch (error) {
        console.error('Error al verificar el estado de la ejecución:', error);
        throw error;
    }
}
// Función para limpiar contenido en formato Markdown
function cleanMarkdown(text) {
    // Eliminar encabezados de Markdown (líneas que empiezan con #)
    text = text.replace(/^#+\s*/gm, '');

    // Eliminar negritas con asteriscos (e.g., **texto en negritas**)
    text = text.replace(/\*\*(.*?)\*\*/g, '$1');

    // Eliminar enlaces en formato Markdown (e.g., [texto](url))
    text = text.replace(/\[.*?\]\((.*?)\)/g, '$1');

    return text;
}

const processToolCalls = async (client, thread_id, run_id, tool_data) => {
    const startTime = Date.now();
    while (Date.now() - startTime < 8000) {  // Límite de 8 segundos
        const runStatus = await client.beta.threads.runs.retrieve(thread_id, run_id);
        console.log(`Checking run status: ${runStatus.status}`);

        if (runStatus.status === 'completed') {
            const messages = await client.beta.threads.messages.list(thread_id);

            // Verificar que existan mensajes y que la estructura sea correcta
            if (!messages.data || messages.data.length === 0 || 
                !messages.data[0].content || !messages.data[0].content[0] || 
                !messages.data[0].content[0].text || !messages.data[0].content[0].text.value) {
                console.error('Error: Estructura inesperada en los mensajes');
                return { response: "error", status: "failed" };
            }

            let messageContent = messages.data[0].content[0].text.value;
            console.log(`Message content before cleaning: ${messageContent}`);

            // Limpiar el contenido del mensaje
            messageContent = cleanMarkdown(messageContent);
            messageContent = messageContent.replace(/【.*?†.*?】/g, '');  // Eliminar cualquier referencia extraña
            messageContent = messageContent.replace(/\s+/g, ' ').trim();  // Eliminar espacios extra

            console.log(`Message content after cleaning: ${messageContent}`);

            return { response: messageContent, status: "completed" };
        }

        if (runStatus.status === 'requires_action') {
            console.log("Run requires action, handling...");
            for (const toolCall of runStatus.required_action.submit_tool_outputs.tool_calls) {
                const functionName = toolCall.function.name;  // Usar nombre descriptivo

                let args;
                try {
                    args = JSON.parse(toolCall.function.arguments);
                } catch (error) {
                    console.error(`JSON decoding failed: ${error.message}. Input: ${toolCall.function.arguments}`);
                    args = {};
                }

                if (tool_data.function_map && tool_data.function_map[functionName]) {
                    const functionToCall = tool_data.function_map[functionName];
                    try {
                        const output = await functionToCall(args);
                        await client.beta.threads.runs.submit_tool_outputs(thread_id, run_id, {
                            tool_outputs: [{
                                tool_call_id: toolCall.id,
                                output: JSON.stringify(output)
                            }]
                        });
                    } catch (error) {
                        console.error(`Error calling function ${functionName}: ${error.message}`);
                    }
                } else {
                    console.warn(`Function ${functionName} not found in tool data.`);
                }
            }
        }

        if (runStatus.status === 'failed') {
            console.error("Run failed");
            return { response: "error", status: "failed" };
        }

        // Esperar 2 segundos antes de volver a verificar
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log("Run timed out");
    return { response: "timeout", status: "timeout" };
};


// Función para cargar herramientas desde un directorio
const load_tools_from_directory = (directory) => {
    const tool_data = { tool_configs: [], function_map: {} };  // Usar siempre function_map

    // Leer todos los archivos del directorio
    fs.readdirSync(directory).forEach(file => {
        if (file.endsWith('.js')) {
            const tool = require(path.join(directory, file));

            // Si el archivo tiene un tool_config, agregarlo
            if (tool.tool_config) {
                tool_data.tool_configs.push(tool.tool_config);
            }

            // Mapear todas las funciones exportadas
            Object.keys(tool).forEach(funcName => {
                if (typeof tool[funcName] === 'function') {
                    tool_data.function_map[funcName] = tool[funcName];  // Guardar en function_map
                }
            });
        }
    });

    return tool_data;
};


// Exportar funciones y cliente OpenAI
module.exports = {
    addThread,
    checkRunStatus,
    processToolCalls,
    client,  // Usamos el cliente OpenAI inicializado
    verifyApiKey,
    load_tools_from_directory  // Exportar middleware para verificar la clave API
};
