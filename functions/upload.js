import { errorHandling, telemetryData } from "./utils/middleware";

// 处理 OPTIONS 预检请求
export async function onRequestOptions(context) {
    return new Response(null, {
        status: 200,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Max-Age': '86400', // 24小时
        }
    });
}

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const clonedRequest = request.clone();
        const formData = await clonedRequest.formData();

        await errorHandling(context);
        telemetryData(context);

        // 获取所有上传的文件
        const files = [];
        for (const [key, value] of formData.entries()) {
            if (key === 'file[]' || key === 'file') {  // 支持单文件和多文件上传
                files.push(value);
            }
        }

        if (files.length === 0) {
            throw new Error('No files uploaded');
        }

        // 预验证文件
        const { validFiles, errors } = preValidateFiles(files);
        
        if (validFiles.length === 0) {
            throw new Error(`No valid files to upload: ${errors.join(', ')}`);
        }

        // 智能并发控制处理文件上传
        const results = await processFilesConcurrently(validFiles, env, request);

        // 批量处理KV操作
        const { successfulUploads, kvOperations } = separateResultsAndKVOps(results, env);
        
        if (kvOperations.length > 0) {
            await batchKVOperations(env, kvOperations);
        }

        return new Response(
            JSON.stringify(successfulUploads.map(result => ({ 'src': result.src, 'thumbnail': result.thumbnail }))),
            {
                status: 200,
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                }
            }
        );

    } catch (error) {
        console.error('Upload error:', error);
        return new Response(
            JSON.stringify({
                error: error.message,
                details: error.response || 'No additional details'
            }),
            {
                status: 500,
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                }
            }
        );
    }
}

// 预验证文件
function preValidateFiles(files) {
    const validFiles = [];
    const errors = [];
    
    for (const file of files) {
        // 文件大小限制 10GB
        if (file.size > 10 * 1024 * 1024 * 1024) {
            errors.push(`File too large (>10GB): ${file.name}`);
            continue;
        }
        
        // 检查文件类型（可选，根据需要调整）
        if (file.size === 0) {
            errors.push(`Empty file: ${file.name}`);
            continue;
        }
        
        validFiles.push(file);
    }
    
    return { validFiles, errors };
}

// 智能并发控制
function getConcurrencyLimit(files) {
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    const avgSize = totalSize / files.length;
    
    // 根据平均文件大小动态调整并发数
    if (avgSize > 100 * 1024 * 1024) return 1;      // 100MB以上，串行处理
    if (avgSize > 10 * 1024 * 1024) return 2;       // 10MB-100MB，低并发
    if (avgSize > 2 * 1024 * 1024) return 3;        // 2MB-10MB，中等并发
    return 4;                                        // 2MB以下，较高并发
}

// 并发处理文件上传
async function processFilesConcurrently(files, env, request) {
    const concurrencyLimit = getConcurrencyLimit(files);
    const results = [];
    
    console.log(`Processing ${files.length} files with concurrency limit: ${concurrencyLimit}`);
    
    for (let i = 0; i < files.length; i += concurrencyLimit) {
        const batch = files.slice(i, i + concurrencyLimit);
        const batchPromises = batch.map(file => processFileUploadWithRetry(file, env, request));
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
        
        // 批次间添加小延迟，避免触发API限制
        if (i + concurrencyLimit < files.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    
    return results;
}

// 分离结果和KV操作
function separateResultsAndKVOps(results, env) {
    const successfulUploads = [];
    const kvOperations = [];
    
    for (const result of results) {
        if (result && result.success) {
            successfulUploads.push(result.data);
            if (result.kvOperation && env.img_url) {
                kvOperations.push(result.kvOperation);
            }
        }
    }
    
    return { successfulUploads, kvOperations };
}

// 批量KV操作
async function batchKVOperations(env, kvOperations) {
    const batchSize = 5; // 每批5个操作，避免并发过高
    
    for (let i = 0; i < kvOperations.length; i += batchSize) {
        const batch = kvOperations.slice(i, i + batchSize);
        
        try {
            await Promise.all(batch.map(async (op) => {
                try {
                    await op();
                } catch (error) {
                    console.error('KV operation failed:', error);
                }
            }));
        } catch (error) {
            console.error('Batch KV operation failed:', error);
        }
        
        // 批次间小延迟
        if (i + batchSize < kvOperations.length) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }
}

// 带重试的文件上传
async function processFileUploadWithRetry(uploadFile, env, request, maxRetries = 2) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await processFileUpload(uploadFile, env, request);
            return result;
        } catch (error) {
            console.error(`Upload attempt ${attempt} failed for ${uploadFile.name}:`, error);
            
            if (attempt === maxRetries) {
                return {
                    success: false,
                    error: error.message,
                    fileName: uploadFile.name
                };
            }
            
            // 指数退避重试
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 3000);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

async function processFileUpload(uploadFile, env, request) {
    const fileName = uploadFile.name;
    const fileExtension = fileName.split('.').pop().toLowerCase();

    const telegramFormData = new FormData();
    telegramFormData.append("chat_id", env.TG_Chat_ID);
    telegramFormData.append("document", uploadFile);

    const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/sendDocument`;
    const response = await fetch(apiUrl, {
        method: "POST",
        body: telegramFormData
    });

    const responseData = await response.json();

    if (!response.ok) {
        console.error('Error uploading file:', fileName, responseData);
        throw new Error(`Telegram API error: ${responseData.description || 'Unknown error'}`);
    }
    
    const fileInfo = getFileInfo(responseData);
    if (!fileInfo) {
        throw new Error(`Failed to get file info for: ${fileName}`);
    }

    const baseUrl = new URL(request.url).origin;
    const fileData = {
        src: `${baseUrl}/file/${fileInfo.fileId}.${fileExtension}`,
        fileName: fileName,
        width: fileInfo.width,
        height: fileInfo.height,
        thumbnail: fileInfo.thumbnail ? {
            src: `${baseUrl}/file/${fileInfo.thumbnail.file_id}.${fileExtension}`,
            width: fileInfo.thumbnail.width,
            height: fileInfo.thumbnail.height
        } : null
    };

    // 准备KV操作函数（延迟执行）
    const kvOperation = async () => {
        await env.img_url.put(`${fileInfo.fileId}.${fileExtension}`, "", {
            metadata: {
                TimeStamp: Date.now(),
                ListType: "None",
                Label: "None",
                liked: false,
                fileName: fileName,
                fileSize: uploadFile.size,
            }
        });
    };

    return {
        success: true,
        data: fileData,
        kvOperation: kvOperation
    };
}

function getFileInfo(response) {
    if (!response.ok || !response.result) {
        return null;
    }

    const result = response.result;
    if (result.sticker){
        return {
            fileId: result.sticker.file_id,
            width: result.sticker.width || null,
            height: result.sticker.height || null,
            thumbnail: result.sticker.thumbnail ? {
                file_id: result.sticker.thumbnail.file_id,
                file_size: result.sticker.thumbnail.file_size,
                width: result.sticker.thumbnail.width,
                height: result.sticker.thumbnail.height
            } : null
        }
    }
    if (result.document) {
        return {
            fileId: result.document.file_id,
            width: result.document.width || null,
            height: result.document.height || null,
            thumbnail: result.document.thumbnail ? {
                file_id: result.document.thumbnail.file_id,
                file_size: result.document.thumbnail.file_size,
                width: result.document.thumbnail.width,
                height: result.document.thumbnail.height
            } : null
        };
    }
    if (result.video) {
        return {
            fileId: result.video.file_id,
            width: result.video.width || null,
            height: result.video.height || null,
            thumbnail: result.video.thumbnail ? {
                file_id: result.video.thumbnail.file_id,
                file_size: result.video.thumbnail.file_size,
                width: result.video.thumbnail.width,
                height: result.video.thumbnail.height
            } : null
        };
    }

    return null;
}