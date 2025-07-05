import { errorHandling, telemetryData } from "./utils/middleware";

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
            if (key === 'file[]' || key === 'file') {
                files.push(value);
            }
        }

        if (files.length === 0) {
            throw new Error('No files uploaded');
        }

        // 优化：使用 Promise.allSettled 处理所有文件上传，支持部分成功
        const results = await Promise.allSettled(
            files.map(file => processFileUploadOptimized(file, env, request))
        );

        // 分离成功和失败的结果
        const successful = [];
        const failed = [];
        
        results.forEach((result, index) => {
            if (result.status === 'fulfilled' && result.value) {
                successful.push(result.value);
            } else {
                failed.push({
                    fileName: files[index].name,
                    error: result.reason?.message || 'Unknown error'
                });
            }
        });

        // 批量处理 KV 操作
        if (successful.length > 0 && env.img_url) {
            await batchKVOperations(successful, env);
        }

        // 构建响应
        const response = {
            successful: successful.map(result => ({
                src: result.src,
                thumbnail: result.thumbnail,
                fileName: result.fileName
            })),
            failed: failed,
            total: files.length,
            successCount: successful.length,
            failCount: failed.length,
            successRate: successful.length / files.length
        };

        // 根据成功率决定状态码
        const statusCode = successful.length > 0 ? 200 : 500;

        return new Response(JSON.stringify(response), {
            status: statusCode,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('Upload processing error:', error);
        return new Response(
            JSON.stringify({
                error: error.message,
                details: error.response || 'No additional details',
                successful: [],
                failed: [],
                total: 0,
                successCount: 0,
                failCount: 0,
                successRate: 0
            }),
            {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

// 优化的文件上传处理函数
async function processFileUploadOptimized(uploadFile, env, request) {
    try {
        const fileName = uploadFile.name;
        const fileExtension = fileName.split('.').pop().toLowerCase();
        const fileSize = uploadFile.size;

        // 文件大小检查
        if (fileSize > 10 * 1024 * 1024 * 1024) { // 10GB 限制
            throw new Error(`File too large: ${fileName} (${fileSize} bytes)`);
        }

        // 准备上传数据
        const telegramFormData = new FormData();
        telegramFormData.append("chat_id", env.TG_Chat_ID);
        telegramFormData.append("document", uploadFile);

        const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/sendDocument`;
        
        // 使用优化的 fetch 进行上传
        const response = await optimizedFetch(apiUrl, {
            method: "POST",
            body: telegramFormData
        });

        const responseData = await response.json();

        if (!response.ok) {
            throw new Error(`Telegram API error: ${responseData.error_code} - ${responseData.description}`);
        }

        const fileInfo = getFileInfo(responseData);
        if (!fileInfo) {
            throw new Error('Failed to extract file info from Telegram response');
        }

        const baseUrl = new URL(request.url).origin;
        
        return {
            fileId: fileInfo.fileId,
            fileName: fileName,
            fileExtension: fileExtension,
            fileSize: fileSize,
            src: `${baseUrl}/file/${fileInfo.fileId}.${fileExtension}`,
            width: fileInfo.width,
            height: fileInfo.height,
            thumbnail: fileInfo.thumbnail ? {
                src: `${baseUrl}/file/${fileInfo.thumbnail.file_id}.${fileExtension}`,
                width: fileInfo.thumbnail.width,
                height: fileInfo.thumbnail.height
            } : null,
            timestamp: Date.now()
        };

    } catch (error) {
        console.error('Error processing file:', uploadFile.name, error);
        throw error;
    }
}

// 优化的 fetch 函数，支持连接复用和智能重试
async function optimizedFetch(url, options, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const response = await fetch(url, {
                ...options,
                // 连接复用优化
                keepalive: true,
                headers: {
                    ...options.headers,
                    'Connection': 'keep-alive'
                }
            });

            if (response.ok) {
                return response;
            }

            // 根据响应状态决定是否重试
            if (response.status === 429) {
                // 速率限制：指数退避
                const delay = Math.pow(2, attempt) * 1000;
                console.log(`Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else if (response.status >= 500) {
                // 服务器错误：短延迟重试
                const delay = 500 * (attempt + 1);
                console.log(`Server error ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                // 客户端错误：不重试
                return response;
            }

        } catch (error) {
            if (attempt === maxRetries - 1) {
                throw error;
            }
            
            // 网络错误：短延迟重试
            const delay = 1000 * (attempt + 1);
            console.log(`Network error, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries}):`, error.message);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// 批量 KV 操作优化
async function batchKVOperations(successfulUploads, env) {
    if (!env.img_url || successfulUploads.length === 0) {
        return;
    }

    try {
        // 并行执行所有 KV 写入操作
        const kvPromises = successfulUploads.map(upload => {
            const key = `${upload.fileId}.${upload.fileExtension}`;
            return env.img_url.put(key, "", {
                metadata: {
                    TimeStamp: upload.timestamp,
                    ListType: "None",
                    Label: "None",
                    liked: false,
                    fileName: upload.fileName,
                    fileSize: upload.fileSize,
                    width: upload.width,
                    height: upload.height
                }
            });
        });

        await Promise.allSettled(kvPromises);
        console.log(`Batch KV operations completed for ${successfulUploads.length} files`);
    } catch (error) {
        console.error('Batch KV operations failed:', error);
        // KV 操作失败不影响主要上传流程
    }
}

// 优化的文件信息提取函数
function getFileInfo(response) {
    if (!response.ok || !response.result) {
        return null;
    }

    const result = response.result;
    
    // 处理贴纸
    if (result.sticker) {
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
        };
    }
    
    // 处理文档
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
    
    // 处理视频
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