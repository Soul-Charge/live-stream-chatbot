"""
genie-tts 2.0.2 的共享修复。

修复内容：LRUCacheDict 淘汰 bug。
原实现继承 OrderedDict 并重写 __getitem__，而 OrderedDict.popitem 的 C 实现会以
self[key] 的方式取值，淘汰时触发已移除键的 KeyError 并损坏内部状态
（容量 1 时插入第二个键直接抛 KeyError('第一个键')，且 'in' 判断仍为 True）。

用法：
    import genie_fixes
    genie_fixes.apply_lru_fix(capacity)
"""

from collections import OrderedDict


class FixedLRUCacheDict:
    """等价 LRU 语义，使用独立 OrderedDict，不干扰 OrderedDict 的 C 方法。"""

    def __init__(self, capacity):
        self.capacity = max(1, int(capacity))
        self._data = OrderedDict()

    def __contains__(self, key):
        return key in self._data

    def __len__(self):
        return len(self._data)

    def __iter__(self):
        return iter(self._data)

    def __getitem__(self, key):
        value = self._data.pop(key)
        self._data[key] = value  # 访问后移到末尾
        return value

    def __setitem__(self, key, value):
        if key in self._data:
            del self._data[key]
        self._data[key] = value
        while len(self._data) > self.capacity:
            self._data.popitem(last=False)  # 删除最旧的

    def __delitem__(self, key):
        del self._data[key]

    def get(self, key, default=None):
        try:
            return self[key]
        except KeyError:
            return default

    def clear(self):
        self._data.clear()

    def keys(self):
        return self._data.keys()

    def values(self):
        return self._data.values()

    def items(self):
        return self._data.items()

    def __repr__(self):
        return repr(self._data)


def apply_lru_fix(capacity: int) -> None:
    """替换已创建 ModelManager singleton 的缓存为修复后的 LRU 实现。"""
    from genie_tts import ModelManager as mm

    mm.model_manager.character_to_model = FixedLRUCacheDict(capacity)
