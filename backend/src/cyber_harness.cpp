#include "cyber_harness.h"

#include <chrono>
#include <iostream>
#include <thread>

#include "cyber/cyber.h"
#include "cyber/init.h"
#include "cyber/class_loader/class_loader.h"
#include "cyber/class_loader/class_loader_manager.h"
#include "cyber/component/component_base.h"
#include "cyber/proto/component_conf.pb.h"
#include "cyber/message/raw_message.h"

using namespace neodrive::cyber;

namespace harness {

CyberComponentHarness::CyberComponentHarness() = default;

CyberComponentHarness::~CyberComponentHarness() {
    unload();
}

bool CyberComponentHarness::load(const CyberConfig& config, std::string& errorOut) {
    unload();

    // Initialize CyberRT runtime if not already done
    if (!_cyberInitialized) {
        if (!neodrive::cyber::Init("replay_harness")) {
            errorOut = "neodrive::cyber::Init failed";
            return false;
        }
        _cyberInitialized = true;
        std::cout << "[CyberHarness] CyberRT initialized" << std::endl;
    }

    // Load the component .so via ClassLoader
    try {
        std::cerr << "[CyberHarness] Loading .so: " << config.soPath << std::endl;
        auto* loader = new class_loader::ClassLoader(config.soPath);
        _classLoader = loader;
        std::cerr << "[CyberHarness] .so loaded, creating class: " << config.className << std::endl;
        std::cerr << std::flush;

        auto comp = loader->CreateClassObj<ComponentBase>(config.className);
        std::cerr << "[CyberHarness] CreateClassObj returned: " << (comp ? "OK" : "NULL") << std::endl;
        if (!comp) {
            errorOut = "ClassLoader::CreateClassObj returned null for: " + config.className;
            unload();
            return false;
        }

        // Build ComponentConfig
        proto::ComponentConfig compConfig;
        compConfig.set_name(config.className);
        if (!config.configFilePath.empty()) {
            compConfig.set_config_file_path(config.configFilePath);
        }
        if (!config.flagFilePath.empty()) {
            compConfig.set_flag_file_path(config.flagFilePath);
        }

        // Add readers for input topics
        for (const auto& topic : config.inputTopics) {
            auto* reader = compConfig.add_readers();
            reader->set_channel(topic);
            reader->set_pending_queue_size(10);
        }

        // Initialize the component with timeout (some components block in Init() waiting for hardware/services)
        std::cerr << "[CyberHarness] Calling Initialize() with 10s timeout..." << std::endl;
        std::cerr << std::flush;

        std::atomic<bool> initDone{false};
        std::atomic<bool> initResult{false};
        auto compPtr = comp.get();

        std::thread initThread([&]() {
            initResult = compPtr->Initialize(compConfig);
            initDone = true;
        });

        // Wait up to 10 seconds
        for (int i = 0; i < 100 && !initDone; ++i) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }

        if (!initDone) {
            errorOut = "Component::Initialize() timed out after 10s (component may be waiting for hardware/time-sync/services)";
            std::cerr << "[CyberHarness] Initialize TIMED OUT — detaching thread" << std::endl;
            initThread.detach(); // can't join, it's stuck
            _component = new std::shared_ptr<ComponentBase>(std::move(comp));
            return false;
        }

        initThread.join();

        if (!initResult) {
            errorOut = "Component::Initialize() returned false (likely missing config/flag files or Cyber env)";
            _component = new std::shared_ptr<ComponentBase>(std::move(comp));
            return false;
        }

        _component = new std::shared_ptr<ComponentBase>(std::move(comp));
        std::cout << "[CyberHarness] Component " << config.className << " initialized" << std::endl;

        // Create a harness node for injecting and capturing messages
        auto harnessNode = CreateNode("replay_harness_io");
        if (!harnessNode) {
            errorOut = "Failed to create harness node";
            unload();
            return false;
        }
        _harnessNode = new std::shared_ptr<Node>(std::move(harnessNode));

        auto* nodePtr = static_cast<std::shared_ptr<Node>*>(_harnessNode);

        // Create writers for input topics
        for (const auto& topic : config.inputTopics) {
            auto writer = (*nodePtr)->CreateWriter<message::RawMessage>(topic);
            if (writer) {
                _writers.push_back({topic, new std::shared_ptr<Writer<message::RawMessage>>(std::move(writer))});
                std::cout << "[CyberHarness] Writer created for " << topic << std::endl;
            }
        }

        // Create readers for output topics
        for (const auto& topic : config.outputTopics) {
            auto entry = std::make_shared<ReaderEntry>();
            entry->topic = topic;

            CallbackFunc<message::RawMessage> cb = [entry](const std::shared_ptr<const message::RawMessage>& msg) {
                std::lock_guard<std::mutex> lock(entry->mtx);
                entry->captured.emplace_back(0, msg->message.size());
            };

            auto reader = (*nodePtr)->CreateReader<message::RawMessage>(topic, cb);
            if (reader) {
                entry->reader = new std::shared_ptr<Reader<message::RawMessage>>(std::move(reader));
                _readers.push_back(entry);
                std::cout << "[CyberHarness] Reader created for " << topic << std::endl;
            }
        }

        _loaded = true;
        return true;

    } catch (const std::exception& e) {
        errorOut = std::string("Exception: ") + e.what();
        unload();
        return false;
    }
}

CyberFrameResult CyberComponentHarness::injectMessage(
        const std::string& topic, uint64_t timestampNs,
        const void* data, size_t dataSize) {

    CyberFrameResult result;
    result.timestampNs = timestampNs;

    if (!_loaded) {
        result.status = "not_loaded";
        result.errorMsg = "Component not loaded";
        result.elapsedMs = 0;
        return result;
    }

    // Find the writer for this topic
    std::shared_ptr<Writer<message::RawMessage>>* writerPtr = nullptr;
    for (auto& w : _writers) {
        if (w.topic == topic) {
            writerPtr = static_cast<std::shared_ptr<Writer<message::RawMessage>>*>(w.writer);
            break;
        }
    }

    if (!writerPtr) {
        result.status = "no_writer";
        result.errorMsg = "No writer for topic: " + topic;
        result.elapsedMs = 0;
        return result;
    }

    // Clear previous captures
    for (auto& r : _readers) {
        std::lock_guard<std::mutex> lock(r->mtx);
        r->captured.clear();
    }

    auto t0 = std::chrono::high_resolution_clock::now();

    // Create RawMessage and write
    auto msg = std::make_shared<message::RawMessage>();
    msg->message.assign(static_cast<const char*>(data), dataSize);
    (*writerPtr)->Write(msg);

    // Wait briefly for output (component may process async)
    std::this_thread::sleep_for(std::chrono::milliseconds(10));

    auto t1 = std::chrono::high_resolution_clock::now();
    result.elapsedMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
    result.status = "ok";

    // Collect captured outputs
    result.capturedOutputs = Json::Value(Json::objectValue);
    for (auto& r : _readers) {
        std::lock_guard<std::mutex> lock(r->mtx);
        Json::Value entry;
        entry["captured_count"] = static_cast<int>(r->captured.size());
        Json::Value msgs(Json::arrayValue);
        for (const auto& [ts, sz] : r->captured) {
            Json::Value m;
            m["size"] = static_cast<int>(sz);
            msgs.append(m);
        }
        entry["messages"] = msgs;
        result.capturedOutputs[r->topic] = entry;
    }

    return result;
}

void CyberComponentHarness::unload() {
    // Clean up writers
    for (auto& w : _writers) {
        delete static_cast<std::shared_ptr<Writer<message::RawMessage>>*>(w.writer);
    }
    _writers.clear();

    // Clean up readers
    for (auto& r : _readers) {
        if (r->reader) {
            delete static_cast<std::shared_ptr<Reader<message::RawMessage>>*>(r->reader);
            r->reader = nullptr;
        }
    }
    _readers.clear();

    // Clean up component — only Shutdown if fully loaded
    if (_component) {
        auto* compPtr = static_cast<std::shared_ptr<ComponentBase>*>(_component);
        if (_loaded) {
            try { (*compPtr)->Shutdown(); } catch (...) {}
        }
        delete compPtr;
        _component = nullptr;
    }

    // Clean up harness node
    if (_harnessNode) {
        delete static_cast<std::shared_ptr<Node>*>(_harnessNode);
        _harnessNode = nullptr;
    }

    // Clean up class loader
    if (_classLoader) {
        delete static_cast<class_loader::ClassLoader*>(_classLoader);
        _classLoader = nullptr;
    }

    _loaded = false;
}

} // namespace harness
