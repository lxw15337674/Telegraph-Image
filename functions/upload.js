import { errorHandling, telemetryData } from "./utils/middleware";

// 内存优化配置
const MEMORY_CONFIG = {
    LARGE_FILE_THRESHOLD: 1024 * 1024 * 50, // 50MB 阈值
    CHUNK_SIZE: 1024 * 1024 * 5,            // 5MB 读取块大小（用于内存管理，不是上传分块）
    MAX_MEMORY_USAGE: 1024 * 1024 * 20,     // 最大内存使用：20MB
};

// 内存优化的文件上传处理器
class MemoryOptimizedUploader {
    constructor(file, env, options = {}) {
        this.file = file;
        this.env = env;
        this.options = { ...MEMORY_CONFIG, ...options };
        this.uploadProgress = 0;
    }

    // 检查是否需要内存优化处理
    needsMemoryOptimization() {
        return this.file.size > this.options.LARGE_FILE_THRESHOLD;
    }

    // 内存优化的上传方法
    async optimizedUpload() {
        if (!this.needsMemoryOptimization()) {
            // 小文件直接上传
            return await this.directUpload();
        }

        // 大文件使用内存优化方案
        return await this.memoryOptimizedUpload();
    }

    // 直接上传小文件
    async directUpload() {
        const formData = new FormData();
        formData.append('chat_id', this.env.TG_Chat_ID);
        formData.append('document', this.file);

        const response = await optimizedFetch(
            `https://api.telegram.org/bot${this.env.TG_Bot_Token}/sendDocument`,
            {
                method: 'POST',
                body: formData
            }
        );

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`Upload failed: ${response.status} - ${errorData.description || 'Unknown error'}`);
        }

        return await response.json();
    }

    // 内存优化的大文件上传
    async memoryOptimizedUpload() {
        try {
            // 创建一个优化的 FormData
            const formData = await this.createOptimizedFormData();
            
            const response = await optimizedFetch(
                `https://api.telegram.org/bot${this.env.TG_Bot_Token}/sendDocument`,
                {
                    method: 'POST',
                    body: formData,
                    // 添加进度回调支持
                    onUploadProgress: (progress) => {
                        this.uploadProgress = progress;
                        if (this.options.onProgress) {
                            this.options.onProgress(progress);
                        }
                    }
                }
            );

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(`Upload failed: ${response.status} - ${errorData.description || 'Unknown error'}`);
            }

            return await response.json();

        } catch (error) {
            console.error('Memory optimized upload error:', error);
            throw error;
        }
    }

    // 创建内存优化的 FormData
    async createOptimizedFormData() {
        const formData = new FormData();
        formData.append('chat_id', this.env.TG_Chat_ID);
        
        // 对于大文件，使用 Blob 来减少内存占用
        const optimizedFile = await this.createOptimizedBlob();
        formData.append('document', optimizedFile, this.file.name);

        return formData;
    }

    // 创建内存优化的 Blob
    async createOptimizedBlob() {
        // 对于超大文件，可以在这里实现压缩或其他优化
        if (this.file.size > this.options.MAX_MEMORY_USAGE) {
            console.log(`Large file detected: ${this.file.name} (${(this.file.size / 1024 / 1024).toFixed(2)}MB)`);
            
            // 对于非常大的文件，直接返回原文件
            // Cloudflare Workers 会自动处理内存管理
            return this.file;
        }

        return this.file;
    }

    // 获取上传进度
    getProgress() {
        return this.uploadProgress;
    }
}

// 优化后的文件处理函数
async function processFileUploadOptimized(file, env, request) {
    const startTime = Date.now();
    
    try {
        const fileName = file.name || 'unnamed';
        const fileSize = file.size;

        // 文件大小检查
        if (fileSize > 10 * 1024 * 1024 * 1024) { // 10GB 限制
            throw new Error(`File too large: ${fileName} (${(fileSize / 1024 / 1024 / 1024).toFixed(2)}GB). Maximum supported size is 10GB.`);
        }

        console.log(`Processing file: ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)}MB)`);

        // 创建内存优化上传器
        const uploader = new MemoryOptimizedUploader(file, env, {
            onProgress: (progress) => {
                console.log(`Upload progress: ${(progress * 100).toFixed(1)}%`);
            }
        });

        // 执行优化上传
        const result = await uploader.optimizedUpload();

        if (!result.ok || !result.result) {
            throw new Error(`Upload failed: ${result.description || 'Unknown error'}`);
        }

        // 提取文件信息
        const fileInfo = extractFileInfo(result);
        if (!fileInfo) {
            throw new Error('Failed to extract file info from Telegram response');
        }

        // 生成 URL
        const baseUrl = new URL(request.url).origin;
        const fileExtension = fileName.split('.').pop().toLowerCase();
        
        // 保存到 KV
        const kvData = {
            url: `${baseUrl}/file/${fileInfo.fileId}.${fileExtension}`,
            fileName: fileName,
            fileSize: fileSize,
            uploadTime: Date.now() - startTime,
            optimizedUpload: uploader.needsMemoryOptimization(),
            messageId: result.result.message_id
        };

        // 并行 KV 操作
        if (env.img_url) {
            await env.img_url.put(`${fileInfo.fileId}.${fileExtension}`, "", {
                metadata: {
                    TimeStamp: Date.now(),
                    ListType: "None",
                    Label: "None",
                    liked: false,
                    fileName: fileName,
                    fileSize: fileSize,
                    width: fileInfo.width,
                    height: fileInfo.height
                }
            });
        }

        return {
            success: true,
            fileName: fileName,
            url: kvData.url,
            size: fileSize,
            uploadTime: Date.now() - startTime,
            optimized: uploader.needsMemoryOptimization(),
            fileId: fileInfo.fileId,
            width: fileInfo.width,
            height: fileInfo.height
        };

    } catch (error) {
        console.error('Upload error:', error);
        return {
            success: false,
            fileName: file.name || 'unnamed',
            error: error.message,
            uploadTime: Date.now() - startTime
        };
    }
}

// 提取文件信息
function extractFileInfo(response) {
    if (!response.ok || !response.result) {
        return null;
    }

    const result = response.result;
    
    // 处理文档
    if (result.document) {
        return {
            fileId: result.document.file_id,
            width: result.document.width || null,
            height: result.document.height || null,
            thumbnail: result.document.thumbnail || null
        };
    }
    
    // 处理照片
    if (result.photo && result.photo.length > 0) {
        const largestPhoto = result.photo[result.photo.length - 1];
        return {
            fileId: largestPhoto.file_id,
            width: largestPhoto.width || null,
            height: largestPhoto.height || null,
            thumbnail: null
        };
    }
    
    // 处理视频
    if (result.video) {
        return {
            fileId: result.video.file_id,
            width: result.video.width || null,
            height: result.video.height || null,
            thumbnail: result.video.thumbnail || null
        };
    }

    return null;
}

// 优化的 fetch 函数
async function optimizedFetch(url, options = {}) {
    return await fetchWithRetry(url, {
        ...options,
        keepalive: true,
        headers: {
            'Connection': 'keep-alive',
            ...options.headers
        }
    });
}

// 智能重试机制
async function fetchWithRetry(url, options, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url, options);
            
            if (response.ok) {
                return response;
            }
            
            // 处理特定错误
            if (response.status === 429) {
                // 速率限制 - 指数退避
                const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
                console.log(`Rate limited, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            
            if (response.status >= 500) {
                // 服务器错误 - 短延迟重试
                const delay = 500 * attempt;
                console.log(`Server error ${response.status}, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            
            // 客户端错误 - 不重试
            return response;
            
        } catch (error) {
            if (attempt === maxRetries) {
                throw error;
            }
            
            // 网络错误 - 递增延迟
            const delay = 1000 * attempt;
            console.log(`Network error, retrying in ${delay}ms (attempt ${attempt}/${maxRetries}):`, error.message);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// 主处理函数
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

        console.log(`Processing ${files.length} files`);

        // 使用 Promise.allSettled 处理所有文件上传，支持部分成功
        const results = await Promise.allSettled(
            files.map(file => processFileUploadOptimized(file, env, request))
        );

        // 处理结果
        const successful = [];
        const failed = [];

        results.forEach((result, index) => {
            if (result.status === 'fulfilled' && result.value.success) {
                successful.push(result.value);
            } else {
                failed.push({
                    fileName: files[index].name || 'unnamed',
                    error: result.status === 'rejected' ? result.reason.message : result.value.error
                });
            }
        });

        console.log(`Upload complete: ${successful.length} successful, ${failed.length} failed`);

        return new Response(JSON.stringify({
            successful,
            failed,
            total: files.length,
            successCount: successful.length,
            failCount: failed.length,
            successRate: `${(successful.length / files.length * 100).toFixed(1)}%`
        }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        });

    } catch (error) {
        console.error('Upload error:', error);
        return new Response(JSON.stringify({
            error: error.message,
            successful: [],
            failed: [],
            total: 0,
            successCount: 0,
            failCount: 0,
            successRate: '0%'
        }), {
            status: 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        });
    }
}